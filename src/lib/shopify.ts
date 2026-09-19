import "server-only";

import { createHash } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyAccessToken, SHOPIFY_API_VERSION } from "@/lib/shopify-auth";
import { writeAuditEvent } from "@/lib/audit";
import { loadVocab } from "@/lib/sku/vocab-live";
import { SIZES } from "@/lib/sku/vocab";
import { originLabel } from "@/lib/studio/copy-prompt";
import { loadDesignDetail } from "./studio/load";
import { colorNameFor, describeDesignFacts } from "./studio/facts";
import { ALL_ANGLES } from "./studio/state";

// Stage 7b — Shopify push (build guide §11.3). Creates/updates a DRAFT
// product; going live from DRAFT stays a human act inside Shopify admin.
//
// Token flow reuses lib/shopify-auth's cached client-credentials grant
// (never a long-lived shpat_ token) and its API version — the local "2025-01"
// this file used to pin has since dropped productCreateMedia entirely.
//
// 19 Sep (Ansh) — the push carries the whole product now, not just words and
// pictures: the retail price, one tracked variant per size (SKU and barcode
// both the full Drevi SKU), the stock count, and the five product metafields
// he defined in Shopify. ONE mutation does it: productSet is a full sync, so
// a re-push reconciles variants and metafields instead of piling up
// duplicates — which is also why status/vendor are only sent on create, so a
// product a human has published or re-branded is never knocked back.

const SIZE_OPTION_NAME = "Size";
const VENDOR = "Drevi Fashion";
/** The namespace Ansh's five product metafield definitions live in. */
const CUSTOM_NS = "custom";
/** Ours, undefined in Shopify admin on purpose: bookkeeping, not merchandising. */
const DREVI_NS = "drevi";
const MEDIA_FINGERPRINT_KEY = "media_fingerprint";

/** The five metafields, in the order the Shopify admin lists them. */
const META_KEYS = ["handwork", "fabric", "sub_category", "category", "origin"] as const;
type MetaKey = (typeof META_KEYS)[number];

const ANGLE_LABEL: Record<string, string> = {
  front: "front", back: "back", side: "side",
  lifestyle: "lifestyle", detail_1: "detail", detail_2: "detail",
};

export function shopifyEnabled(): boolean {
  return (process.env.SHOPIFY_ENABLED ?? "").toLowerCase() === "true";
}

interface UserError { field?: string[] | null; message: string }

function throwUserErrors(what: string, errors: UserError[] | undefined | null): void {
  if (!errors?.length) return;
  throw new Error(
    `${what}: ${errors.map((e) => [e.field?.filter(Boolean).join("."), e.message].filter(Boolean).join(" — ")).join("; ")}`,
  );
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN not set");
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const call = async (token: string) =>
    fetch(url, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });

  // One forced-refresh retry on 401, the same contract shopifyAdminFetch has:
  // a token cached just under the refresh margin must not fail a push.
  let res = await call(await getShopifyAccessToken());
  if (res.status === 401) res = await call(await getShopifyAccessToken(true));
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Shopify: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data as T;
}

/**
 * The size token between the base SKU and the colour — DD-KUR-TUN-021-L-GLD
 * is base + "L" + colour. Null when the row does not fit the shape, which is
 * how a stray SKU is skipped rather than pushed as a nonsense variant.
 */
export function sizeCodeFrom(sku: string, baseSku: string, color: string): string | null {
  const u = sku.trim().toUpperCase();
  const prefix = `${baseSku.trim().toUpperCase()}-`;
  const suffix = `-${color.trim().toUpperCase()}`;
  if (!u.startsWith(prefix) || !u.endsWith(suffix)) return null;
  return u.slice(prefix.length, u.length - suffix.length) || null;
}

/** Mint order (XS→XXXL, then numeric, then Free Size…); unknown codes sort last. */
const SIZE_ORDER = Object.keys(SIZES);
function sizeRank(code: string): number {
  const i = SIZE_ORDER.indexOf(code);
  return i === -1 ? SIZE_ORDER.length : i;
}

async function resolveLocationId(): Promise<string> {
  const fromEnv = process.env.SHOPIFY_LOCATION_ID?.trim();
  if (fromEnv) return fromEnv.startsWith("gid://") ? fromEnv : `gid://shopify/Location/${fromEnv}`;
  const data = await gql<{ locations: { nodes: { id: string; isActive: boolean; shipsInventory: boolean }[] } }>(
    `{ locations(first: 20) { nodes { id isActive shipsInventory } } }`,
    {},
  );
  const active = data.locations.nodes.filter((l) => l.isActive);
  const chosen = active.find((l) => l.shipsInventory) ?? active[0];
  if (!chosen) throw new Error("Shopify has no active location to stock inventory at");
  return chosen.id;
}

export async function publishShopify(designId: string, staffId: string, staffEmail: string): Promise<{
  ok: boolean;
  error?: string;
  blockers?: string[];
  remoteId?: string;
  variants?: number;
  price?: number;
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
      .select("angle, storage_path, published_at")
      .eq("sku_base", board.baseSku)
      .eq("color", board.color);
    if (!images?.length) throw new Error("Push wholesale first — Shopify media uses the published set");
    const rank = new Map<string, number>(ALL_ANGLES.map((a, i) => [a as string, i]));
    const ordered = [...images].sort((a, b) => (rank.get(a.angle) ?? 99) - (rank.get(b.angle) ?? 99));
    const { data: pub } = admin.storage.from("product-images").getPublicUrl("x");
    const bucketBase = pub.publicUrl.replace(/\/x$/, "");

    // Deterministic storage paths mean a reshoot reuses its path — the stamp
    // is what makes this change when the pixels do.
    const mediaFingerprint = createHash("sha256")
      .update(ordered.map((i) => `${i.angle}:${i.storage_path}:${i.published_at ?? ""}`).join("|"))
      .digest("hex")
      .slice(0, 32);

    const [{ data: designRow }, vocab] = await Promise.all([
      admin
        .from("designs")
        .select("category, sub_category, color, color_name, fabric, handwork, origin, auto_mrp, mrp_override")
        .eq("id", designId)
        .maybeSingle(),
      loadVocab(),
    ]);
    if (!designRow) throw new Error("Design row not found");

    // Shopify is the RETAIL storefront: the price is the MRP the Product
    // Master computes, never the trade price. designs.auto_mrp / mrp_override
    // had no downstream reader until now (0020 said so in as many words), so
    // this is the first thing that spends it — and a design nobody has priced
    // must not reach a customer at ₹0.
    const retail = Number(designRow.mrp_override ?? designRow.auto_mrp ?? 0);
    if (!(retail > 0)) {
      throw new Error("Retail price (MRP) not set — set it in Product Master before pushing to Shopify");
    }

    const { data: variantRows } = await admin
      .from("wholesale_products")
      .select("sku, current_qty")
      .like("sku", `${board.baseSku}-%`);
    const group = (variantRows ?? []).filter((v) => v.sku.toUpperCase().endsWith(`-${board.color.toUpperCase()}`));
    const stocked = group
      .map((v) => ({ sku: v.sku.trim().toUpperCase(), qty: Math.max(0, Number(v.current_qty) || 0), size: sizeCodeFrom(v.sku, board.baseSku, board.color) }))
      .filter((v): v is { sku: string; qty: number; size: string } => !!v.size)
      .sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size));
    if (!stocked.length) throw new Error("No size variants found for this design — mint its SKUs first");

    // OFFERED SIZES (Ansh, 19 Sep). What the portal STOCKS and what the shop
    // SELLS are not the same list any more. Every garment carries enough
    // margin that the piece hanging in the showroom as an L is alterable to M,
    // L or XL, so all three are offered whatever single size was received:
    //
    //   Curated Collection   M · L · XL              all at the retail price
    //   Drevi Originals      M · L · XL · Custom     Custom at +20%, floored
    //
    // A design with no origin set keeps the old behaviour — exactly the sizes
    // the portal holds. Nothing is invented for a garment nobody has
    // classified, and on prod that is still most of them.
    const OFFERED = ["M", "L", "XL"];
    const CUSTOM_SIZE = "CTM"; // the vocab's "Custom / Made to Measure"
    const CUSTOM_MULTIPLIER = 1.2;
    const origin = designRow.origin?.trim() || null;
    const offersAlterationSizes = origin === "curated" || origin === "drevi_original";

    // One physical garment backs all three sizes, so they share its stock
    // rather than each claiming its own. Shopify will still let three people
    // buy it — that is the trade for offering an alterable piece in every
    // size, and it is the shop's call to make, not something to solve here.
    const groupQty = stocked.reduce((sum, v) => sum + v.qty, 0);
    const skuFor = (size: string) => `${board.baseSku.toUpperCase()}-${size}-${board.color.toUpperCase()}`;

    const sized: { sku: string; qty: number; size: string; label: string; price: number }[] = offersAlterationSizes
      ? [
          ...OFFERED.map((size) => ({
            sku: skuFor(size),
            // A size the portal actually holds keeps its own count; the other
            // two ride on the group, because the same piece is what fills them.
            qty: stocked.find((v) => v.size === size)?.qty ?? groupQty,
            size,
            label: size,
            price: retail,
          })),
          // Made to measure, Drevi Originals only. Floored to the rupee, as asked.
          ...(origin === "drevi_original"
            ? [{ sku: skuFor(CUSTOM_SIZE), qty: groupQty, size: CUSTOM_SIZE, label: "Custom", price: Math.floor(retail * CUSTOM_MULTIPLIER) }]
            : []),
        ]
      : stocked.map((v) => ({ ...v, label: vocab.sizes[v.size] ?? v.size, price: retail }));

    const facts = describeDesignFacts(
      { category: designRow.category, subCategory: designRow.sub_category, color: designRow.color, colorName: designRow.color_name },
      vocab,
    );
    // Codes never leave the portal: the metafields carry the words a customer
    // reads ("Pre-Draped", not "PRD"; "Drevi Originals", not "drevi_original").
    const metaValues: Record<MetaKey, string | null> = {
      handwork: designRow.handwork?.trim() || null,
      fabric: designRow.fabric?.trim() || null,
      sub_category: facts.subCategoryName?.trim() || null,
      category: facts.categoryName?.trim() || null,
      origin: originLabel(designRow.origin)?.trim() || null,
    };

    // Fallback title names the colour (Gold, not GLD).
    const title = copy?.title || board.title || `${board.baseSku} ${colorNameFor(board.color, vocab) ?? board.color}`;
    const descriptionHtml = copy?.description ? `<p>${copy.description}</p>` : "";
    const tags = copy?.tags ? Object.values(copy.tags).filter(Boolean) : [];

    const { data: existing } = await admin
      .from("publish_targets")
      .select("remote_id")
      .eq("design_id", designId)
      .eq("portal", "shopify")
      .single();
    let remoteId: string | undefined = existing?.remote_id ?? undefined;

    // What is already on the product decides two things: whether the media
    // needs re-uploading at all, and which cleared metafields need deleting
    // (metafieldsSet has no "write null").
    let liveMedia = 0;
    let liveFingerprint: string | null = null;
    let liveMetaKeys: string[] = [];
    if (remoteId) {
      const got = await gql<{
        product: {
          id: string;
          mediaCount: { count: number } | null;
          metafields: { nodes: { key: string }[] };
          fingerprint: { value: string } | null;
        } | null;
      }>(
        `query($id: ID!) {
          product(id: $id) {
            id
            mediaCount { count }
            metafields(first: 25, namespace: "${CUSTOM_NS}") { nodes { key } }
            fingerprint: metafield(namespace: "${DREVI_NS}", key: "${MEDIA_FINGERPRINT_KEY}") { value }
          }
        }`,
        { id: remoteId },
      );
      // A product deleted in Shopify admin leaves a dangling remote_id —
      // create a fresh one rather than failing every push from here on.
      if (!got.product) remoteId = undefined;
      else {
        liveMedia = got.product.mediaCount?.count ?? 0;
        liveFingerprint = got.product.fingerprint?.value ?? null;
        liveMetaKeys = got.product.metafields.nodes.map((n) => n.key);
      }
    }

    const locationId = await resolveLocationId();
    const mediaUnchanged = !!remoteId && liveMedia > 0 && liveFingerprint === mediaFingerprint;

    const metafields = [
      ...META_KEYS.filter((k) => metaValues[k] !== null).map((k) => ({
        namespace: CUSTOM_NS,
        key: k,
        value: metaValues[k] as string,
        type: "single_line_text_field",
      })),
      { namespace: DREVI_NS, key: MEDIA_FINGERPRINT_KEY, value: mediaFingerprint, type: "single_line_text_field" },
    ];

    const input: Record<string, unknown> = {
      ...(remoteId ? { id: remoteId } : { status: "DRAFT", vendor: VENDOR }),
      title,
      descriptionHtml,
      tags,
      productOptions: [{ name: SIZE_OPTION_NAME, values: sized.map((v) => ({ name: v.label })) }],
      variants: sized.map((v) => ({
        optionValues: [{ optionName: SIZE_OPTION_NAME, name: v.label }],
        price: v.price.toFixed(2),
        // Both carry the complete Drevi SKU, size and colour included (Ansh,
        // 19 Sep) — the barcode is what a scanner in the shop reads.
        sku: v.sku,
        barcode: v.sku,
        inventoryItem: { sku: v.sku, tracked: true },
        inventoryQuantities: [{ locationId, name: "available", quantity: v.qty }],
      })),
      metafields,
      // productSet syncs the media set wholesale, so sending it every time
      // would churn every image on a push that only moved a price. Omitting
      // the key leaves the product's media exactly as it is.
      ...(mediaUnchanged
        ? {}
        : {
            files: ordered.map((i) => ({
              originalSource: `${bucketBase}/${i.storage_path}`,
              contentType: "IMAGE",
              alt: `${title} — ${ANGLE_LABEL[i.angle] ?? i.angle}`,
            })),
          }),
    };

    const setRes = await gql<{ productSet: { product: { id: string } | null; userErrors: UserError[] } }>(
      `mutation($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product { id }
          userErrors { field message }
        }
      }`,
      { input },
    );
    throwUserErrors("productSet", setRes.productSet.userErrors);
    if (!setRes.productSet.product) throw new Error("productSet returned no product");
    remoteId = setRes.productSet.product.id;

    // A spec cleared in the portal must clear in Shopify too; metafieldsSet
    // cannot write an empty value, so the removals are their own call.
    const stale = META_KEYS.filter((k) => metaValues[k] === null && liveMetaKeys.includes(k));
    if (stale.length) {
      const del = await gql<{ metafieldsDelete: { userErrors: UserError[] } }>(
        `mutation($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) { userErrors { field message } }
        }`,
        { metafields: stale.map((key) => ({ ownerId: remoteId, namespace: CUSTOM_NS, key })) },
      );
      throwUserErrors("metafieldsDelete", del.metafieldsDelete.userErrors);
    }

    await admin
      .from("publish_targets")
      .update({ state: "live", remote_id: remoteId, last_pushed_at: new Date().toISOString(), error: null })
      .eq("design_id", designId)
      .eq("portal", "shopify");
    await writeAuditEvent({
      eventType: "studio_published",
      staffUserId: staffId,
      notes:
        `shopify draft push ${board.baseSku}·${board.color} → ${remoteId} by ${staffEmail} — ` +
        `₹${retail}${offersAlterationSizes ? ` (${originLabel(origin)} size set)` : ""} on ${sized.length} size(s) ` +
        `[${sized.map((v) => `${v.label}:${v.qty}${v.price === retail ? "" : `@₹${v.price}`}`).join(" ")}], ` +
        `${mediaUnchanged ? "media unchanged" : `${ordered.length} image(s)`}`,
    });
    return { ok: true, remoteId, variants: sized.length, price: retail };
  } catch (err) {
    const message = (err as Error).message;
    await admin.from("publish_targets").update({ state: "error", error: message }).eq("design_id", designId).eq("portal", "shopify");
    return { ok: false, error: message };
  }
}
