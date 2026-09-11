import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedReceiptPhotoUrl } from "@/lib/storage";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { NotesPanel } from "@/components/admin/NotesPanel";
import { listEntityNotes } from "@/lib/entity-notes";
import { BackLink } from "@/components/BackLink";
import { ReceiptDetail, type ReceiptDesign } from "./ReceiptDetail";

type DesignRow = { id: string; base_sku: string; color: string; title: string | null; specs_verified: boolean | null; first_receipt_id: string | null };
type PriceRow = { sku: string; wholesale_price: number | null };
const DESIGN_COLS = "id, base_sku, color, title, specs_verified, first_receipt_id";

// Same (base|color) group rule as lib/studio/load.ts — legacy ReceiptEditor
// lines carry no design_id, so the SKU is the only way back to their design.
function groupKey(sku: string): string | null {
  const p = sku.toUpperCase().split("-");
  return p.length >= 5 && /^\d{2,4}$/.test(p[3]) ? `${p.slice(0, 4).join("-")}|${p[p.length - 1]}` : null;
}
const isKey = (k: string | null): k is string => !!k;

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({ params }: { params: { id: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goods_receipts").select("*").eq("id", params.id).maybeSingle();
  if (!rec) notFound();

  const [{ data: lines }, { data: vendor }, { data: activeVendors }, skus] = await Promise.all([
    admin.from("goods_receipt_lines").select("*").eq("receipt_id", params.id).order("position"),
    admin.from("vendors").select("id, name, city").eq("id", rec.vendor_id).maybeSingle(),
    admin.from("vendors").select("id, name, city").eq("active", true).order("name"),
    fetchAll<{ variant_sku: string }>(admin, "sku_registry", "variant_sku"),
  ]);
  // The receipt's own vendor stays pickable even if deactivated — otherwise
  // the edit form renders it unselected and invites accidental reassignment.
  const vendors = vendor && !(activeVendors ?? []).some((v) => v.id === vendor.id)
    ? [vendor, ...(activeVendors ?? [])]
    : (activeVendors ?? []);
  const billUrl = rec.bill_photo_path ? await signedReceiptPhotoUrl(rec.bill_photo_path) : null;

  const lineRows = lines ?? [];
  const lineSkus: string[] = lineRows.map((l) => l.sku);
  const idsFromLines = [...new Set(lineRows.map((l) => l.design_id).filter(Boolean))] as string[];
  const groupKeys = new Set(lineSkus.map(groupKey).filter(isKey));
  const bases = [...new Set([...groupKeys].map((k) => k.split("|")[0]))];
  const [byId, byBase, priced] = await Promise.all([
    idsFromLines.length ? admin.from("designs").select(DESIGN_COLS).in("id", idsFromLines).then((r) => (r.data ?? []) as DesignRow[]) : ([] as DesignRow[]),
    bases.length ? admin.from("designs").select(DESIGN_COLS).in("base_sku", bases).then((r) => (r.data ?? []) as DesignRow[]) : ([] as DesignRow[]),
    lineSkus.length ? admin.from("wholesale_products").select("sku, wholesale_price").in("sku", lineSkus).then((r) => (r.data ?? []) as PriceRow[]) : ([] as PriceRow[]),
  ]);
  const pricedGroups = new Set(priced.filter((p) => (p.wholesale_price ?? 0) > 0).map((p) => groupKey(p.sku)).filter(isKey));
  const seen = new Map<string, ReceiptDesign>();
  for (const d of [...byId, ...byBase]) {
    const key = `${d.base_sku}|${d.color}`.toUpperCase();
    if (seen.has(d.id) || !(idsFromLines.includes(d.id) || groupKeys.has(key))) continue;
    seen.set(d.id, {
      id: d.id, baseSku: d.base_sku, color: d.color, title: d.title ?? null,
      specsVerified: !!d.specs_verified, priceSet: pricedGroups.has(key), createdHere: d.first_receipt_id === params.id,
    });
  }
  const firstLine = (d: ReceiptDesign) => lineRows.findIndex((l) => l.design_id === d.id || groupKey(l.sku) === `${d.baseSku}|${d.color}`.toUpperCase());
  const designs = [...seen.values()].sort((a, b) => firstLine(a) - firstLine(b));

  return (
    <div className="px-4 md:px-6 py-5 max-w-2xl">
      <BackLink fallback="/admin/receipts" fallbackLabel="Receipts" />
      <ReceiptDetail
        receipt={{
          id: rec.id,
          number: rec.receipt_number,
          vendorId: rec.vendor_id,
          vendorName: vendor?.name ?? "—",
          vendorCity: vendor?.city ?? null,
          date: rec.receipt_date,
          gstMode: rec.gst_mode ?? null,
          gstRate: rec.gst_rate != null ? Number(rec.gst_rate) : null,
          gstInclusive: rec.gst_inclusive ?? null,
          billAmount: rec.bill_amount != null ? Number(rec.bill_amount) : null,
          notes: rec.notes ?? "",
          billUrl,
          createdBy: rec.created_by,
          createdAt: rec.created_at,
          updatedAt: rec.updated_at ?? null,
        }}
        lines={(lines ?? []).map((l) => ({
          id: l.id, sku: l.sku, description: l.description ?? "", qty: l.qty, unitCost: Number(l.unit_cost),
        }))}
        vendors={vendors.map((v) => ({ id: v.id, name: v.name, city: v.city }))}
        registrySkus={skus.map((s) => s.variant_sku)}
        designs={designs}
      />
      <NotesPanel entityType="receipt" entityId={params.id} notes={await listEntityNotes("receipt", params.id)} revalidate={`/admin/receipts/${params.id}`} />
    </div>
  );
}
