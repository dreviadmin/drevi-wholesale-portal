import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyAccessToken } from "@/lib/shopify-auth";
import { writeAuditEvent } from "@/lib/audit";
import { loadDesignDetail } from "./studio/load";

// Stage 7b — Shopify push (build guide §11.3). FULLY implemented but parked
// behind SHOPIFY_ENABLED until ANSH-05 signs off — flipping the flag will
// create DRAFT products in the REAL store, so the switch is deliberately
// Ansh's. Going live from DRAFT stays a human act inside Shopify admin.
//
// Token flow reuses lib/shopify-auth's cached client-credentials grant
// (never a long-lived shpat_ token).

const API_VERSION = "2025-01";

export function shopifyEnabled(): boolean {
  return (process.env.SHOPIFY_ENABLED ?? "").toLowerCase() === "true";
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN not set");
  const token = await getShopifyAccessToken();
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Shopify: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data as T;
}

export async function publishShopify(designId: string, staffId: string, staffEmail: string): Promise<{
  ok: boolean;
  error?: string;
  blockers?: string[];
  remoteId?: string;
}> {
  if (!shopifyEnabled()) return { ok: false, error: "Connect Shopify — parked (ANSH-05)" };
  const admin = createAdminClient();
  const detail = await loadDesignDetail(designId);
  if (!detail) return { ok: false, error: "Design not found" };
  const { board, copy } = detail;

  const target = board.targets.find((t) => t.portal === "shopify");
  if (target && !target.enabled) return { ok: false, error: "Shopify is disabled for this design" };
  const gate = board.gates.shopify;
  if (!gate.ready) return { ok: false, error: "Gate not met", blockers: gate.blockers };

  await admin.from("publish_targets").update({ state: "pushing", error: null }).eq("design_id", designId).eq("portal", "shopify");
  try {
    // Published wholesale set is the media source; sizes/prices from the group.
    const { data: images } = await admin
      .from("product_images")
      .select("angle, storage_path")
      .eq("sku_base", board.baseSku)
      .eq("color", board.color);
    if (!images?.length) throw new Error("Push wholesale first — Shopify media uses the published set");
    const { data: pub } = admin.storage.from("product-images").getPublicUrl("x");
    const bucketBase = pub.publicUrl.replace(/\/x$/, "");
    const mediaUrls = images.map((i) => `${bucketBase}/${i.storage_path}`);

    const { data: variants } = await admin
      .from("wholesale_products")
      .select("sku, wholesale_price")
      .like("sku", `${board.baseSku}-%`);
    const group = (variants ?? []).filter((v) => v.sku.toUpperCase().endsWith(`-${board.color}`));

    const title = copy?.title || board.title || `${board.baseSku} ${board.color}`;
    const descriptionHtml = copy?.description ? `<p>${copy.description}</p>` : "";
    const tags = copy?.tags ? Object.values(copy.tags).filter(Boolean) : [];

    const { data: existing } = await admin
      .from("publish_targets")
      .select("remote_id")
      .eq("design_id", designId)
      .eq("portal", "shopify")
      .single();
    let remoteId: string | undefined = existing?.remote_id ?? undefined;

    if (!remoteId) {
      const created = await gql<{ productCreate: { product: { id: string } | null; userErrors: { message: string }[] } }>(
        `mutation($input: ProductInput!) { productCreate(input: $input) { product { id } userErrors { message } } }`,
        { input: { title, descriptionHtml, tags, status: "DRAFT" } },
      );
      if (!created.productCreate.product) throw new Error(created.productCreate.userErrors.map((e) => e.message).join("; ") || "productCreate failed");
      remoteId = created.productCreate.product.id;
    } else {
      const updated = await gql<{ productUpdate: { userErrors: { message: string }[] } }>(
        `mutation($input: ProductInput!) { productUpdate(input: $input) { userErrors { message } } }`,
        { input: { id: remoteId, title, descriptionHtml, tags } },
      );
      if (updated.productUpdate.userErrors.length) throw new Error(updated.productUpdate.userErrors.map((e) => e.message).join("; "));
    }

    const media = await gql<{ productCreateMedia: { mediaUserErrors: { message: string }[] } }>(
      `mutation($productId: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $productId, media: $media) { mediaUserErrors { message } } }`,
      { productId: remoteId, media: mediaUrls.map((url) => ({ originalSource: url, mediaContentType: "IMAGE" })) },
    );
    if (media.productCreateMedia.mediaUserErrors.length) {
      throw new Error(media.productCreateMedia.mediaUserErrors.map((e) => e.message).join("; "));
    }
    void group; // variant/price sync arrives with the master editor (Stage 8 pricing)

    await admin
      .from("publish_targets")
      .update({ state: "live", remote_id: remoteId, last_pushed_at: new Date().toISOString(), error: null })
      .eq("design_id", designId)
      .eq("portal", "shopify");
    await writeAuditEvent({ eventType: "studio_published", staffUserId: staffId, notes: `shopify draft push ${board.baseSku}·${board.color} → ${remoteId} by ${staffEmail}` });
    return { ok: true, remoteId };
  } catch (err) {
    const message = (err as Error).message;
    await admin.from("publish_targets").update({ state: "error", error: message }).eq("design_id", designId).eq("portal", "shopify");
    return { ok: false, error: message };
  }
}
