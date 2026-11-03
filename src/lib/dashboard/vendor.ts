import { designKeyOf } from "../retail-price-core";
import { pickLastVendor, type ReceiptVendor } from "../last-vendor";
import { normName } from "./lines";

// Who supplied a SKU, in the trust order of last-vendor.ts. Log delivery writes
// a vendor id and never a vendor name, so grouping on the sheet's name alone
// would drop every portal delivery into "No vendor set".

export interface VendorRef { key: string; name: string; vendorSku: string | null }

const NAME_PREFIX = "name:";
export const isProfileKey = (key: string) => !key.startsWith(NAME_PREFIX);

export function buildVendorIndex(input: {
  skus: Iterable<string>;
  vendors: { id: string; name: string | null }[];
  receipts: { id: string; receipt_number: string | null; receipt_date: string | null; created_at: string | null; vendor_id: string | null }[];
  lines: { receipt_id: string; sku: string; vendor_sku: string | null }[];
  info: { sku: string; vendor_name: string | null; vendor_id: string | null; vendor_sku: string | null; last_receipt_date: string | null }[];
  designs: { base_sku: string | null; color: string | null; vendor_id: string | null; vendor_sku: string | null }[];
}): Record<string, VendorRef> {
  const vendorById = new Map(input.vendors.map((v) => [v.id, v]));
  const vendorByName = new Map(input.vendors.filter((v) => v.name).map((v) => [normName(v.name!), v]));
  const receiptById = new Map(input.receipts.map((r) => [r.id, r]));
  const infoBySku = new Map(input.info.map((v) => [v.sku.trim().toUpperCase(), v]));
  const designByKey = new Map(
    input.designs.filter((d) => d.base_sku && d.color).map((d) => [`${d.base_sku}|${d.color}`.toUpperCase(), d]),
  );

  const receiptsBySku = new Map<string, ReceiptVendor[]>();
  for (const l of input.lines) {
    const r = receiptById.get(l.receipt_id);
    if (!r?.vendor_id) continue;
    const sku = l.sku.trim().toUpperCase();
    const list = receiptsBySku.get(sku) ?? [];
    list.push({
      receiptId: r.id, receiptNumber: r.receipt_number ?? "", receiptDate: r.receipt_date, createdAt: r.created_at,
      vendorId: r.vendor_id, vendorName: vendorById.get(r.vendor_id)?.name ?? null, vendorSku: l.vendor_sku,
    });
    receiptsBySku.set(sku, list);
  }

  // A design has one vendor: its latest supplier across every size, the same
  // answer Studio gives. So a product row and the page it opens always agree.
  const skusByDesign = new Map<string, string[]>();
  for (const raw of new Set(input.skus)) {
    const sku = raw.trim().toUpperCase();
    const key = designKeyOf(sku) ?? sku;
    const list = skusByDesign.get(key) ?? [];
    if (!list.includes(sku)) list.push(sku);
    skusByDesign.set(key, list);
  }

  const out: Record<string, VendorRef> = {};
  for (const [designKey, skus] of skusByDesign) {
    const design = designByKey.get(designKey) ?? null;
    const infos = skus.flatMap((sku) => { const i = infoBySku.get(sku); return i ? [i] : []; });
    const picked = pickLastVendor({
      receipts: skus.flatMap((sku) => receiptsBySku.get(sku) ?? []),
      sheet: infos.map((i) => ({ vendorName: i.vendor_name, vendorSku: i.vendor_sku, lastReceiptDate: i.last_receipt_date })),
      design: design ? { vendorId: design.vendor_id, vendorName: vendorById.get(design.vendor_id ?? "")?.name ?? null, vendorSku: design.vendor_sku } : null,
    });

    // product_vendor_info.vendor_id holds sheet codes as well as uuids, so it
    // only counts when it is the key of a real vendor row.
    const profile = picked
      ? (picked.vendorId ? vendorById.get(picked.vendorId) : null) ?? vendorByName.get(normName(picked.name))
      : infos.map((i) => vendorById.get(i.vendor_id ?? "")).find((v) => v?.name);
    if (!picked && !profile) continue;
    const key = profile?.id ?? `${NAME_PREFIX}${normName(picked!.name)}`;
    const name = profile?.name?.trim() || picked!.name;
    const sameVendor = (raw: string | null) => !raw?.trim() || normName(raw) === normName(name);

    for (const sku of skus) {
      // The code this vendor knows this size by: its own delivery, then the
      // sheet if the sheet names the same vendor, then whatever the design has.
      const own = (receiptsBySku.get(sku) ?? [])
        .filter((r) => r.vendorId === profile?.id && r.vendorSku?.trim())
        .sort((x, y) => (y.receiptDate ?? "").localeCompare(x.receiptDate ?? ""))[0];
      const info = infoBySku.get(sku);
      const sheetCode = info && (sameVendor(info.vendor_name) || info.vendor_id === profile?.id) ? info.vendor_sku?.trim() : null;
      out[sku] = { key, name, vendorSku: own?.vendorSku?.trim() || sheetCode || picked?.vendorSku || null };
    }
  }

  // A name-only vendor shows its commonest spelling, not whichever came first.
  const spellings = new Map<string, Map<string, number>>();
  for (const ref of Object.values(out)) {
    if (isProfileKey(ref.key)) continue;
    const counts = spellings.get(ref.key) ?? new Map<string, number>();
    counts.set(ref.name, (counts.get(ref.name) ?? 0) + 1);
    spellings.set(ref.key, counts);
  }
  for (const ref of Object.values(out)) {
    const counts = spellings.get(ref.key);
    if (counts) ref.name = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))[0][0];
  }
  return out;
}
