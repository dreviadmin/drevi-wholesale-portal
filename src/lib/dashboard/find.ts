import { partyName, type DashBuyer, type DashOrder } from "./lines";
import type { DashContext } from "./rollup";
import type { Dim } from "./state";

// The one search box. A pick starts fresh on that thing: a buyer ringing in the
// middle of a vendor drill must not get a narrowed answer.

export interface FindEntry {
  kind: Dim | "order";
  value: string; // the filter value, or the order id
  title: string;
  sub: string;
  text: string; // lower-case haystack
  phones: string[]; // last ten digits
}

const last10 = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

export function buildFindIndex(input: {
  ctx: DashContext;
  buyers: DashBuyer[];
  contactsByBuyer: Record<string, { name: string | null; phone: string | null }[]>;
  orders: DashOrder[];
  vendors: { key: string; name: string }[];
  categories: { key: string; name: string }[];
  events: string[];
}): FindEntry[] {
  const out: FindEntry[] = [];
  for (const d of input.ctx.designs.values()) {
    const skus = d.variants.map((p) => p.sku).join(" ");
    const codes = d.variants.map((p) => {
      const sku = p.sku.trim().toUpperCase();
      const vendor = input.ctx.vendorBySku[sku];
      return (vendor ? vendor.vendorSku : input.ctx.infoBySku.get(sku)?.vendor_sku) ?? "";
    }).join(" ");
    out.push({ kind: "design", value: d.key, title: d.title || d.label, sub: d.label, text: `${d.title} ${d.label} ${skus} ${codes}`.toLowerCase(), phones: [] });
  }
  for (const v of input.vendors) out.push({ kind: "vendor", value: v.key, title: v.name, sub: "", text: v.name.toLowerCase(), phones: [] });
  for (const c of input.categories) out.push({ kind: "category", value: c.key, title: c.name, sub: "", text: c.name.toLowerCase(), phones: [] });
  for (const e of input.events) out.push({ kind: "event", value: e, title: e, sub: "", text: e.toLowerCase(), phones: [] });
  for (const b of input.buyers) {
    const contacts = input.contactsByBuyer[b.id] ?? [];
    const names = contacts.map((c) => c.name ?? "").join(" ");
    out.push({
      kind: "customer", value: b.id, title: partyName(b),
      sub: [b.owner_name, b.city].filter(Boolean).join(" · "),
      text: `${partyName(b)} ${b.owner_name ?? ""} ${b.city ?? ""} ${names}`.toLowerCase(),
      phones: [b.phone, ...contacts.map((c) => c.phone)].map(last10).filter(Boolean),
    });
  }
  for (const o of input.orders) out.push({ kind: "order", value: o.id, title: o.order_number, sub: "", text: o.order_number.toLowerCase(), phones: [] });
  return out;
}

export function searchFind(index: FindEntry[], query: string, limit = 8): FindEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  const digits = q.replace(/\D/g, "");
  const scored: { entry: FindEntry; score: number }[] = [];
  for (const entry of index) {
    const byPhone = digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, "").length && entry.phones.some((p) => p.includes(digits.slice(-10)));
    if (!byPhone && !words.every((w) => entry.text.includes(w))) continue;
    scored.push({ entry, score: byPhone ? 0 : entry.text.startsWith(q) ? 1 : entry.title.toLowerCase().includes(q) ? 2 : 3 });
  }
  return scored.sort((a, b) => a.score - b.score || a.entry.title.localeCompare(b.entry.title, "en")).slice(0, limit).map((s) => s.entry);
}
