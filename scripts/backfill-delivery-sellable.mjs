/**
 * Make garments that Log delivery created HIDDEN sellable at the counter.
 *
 *   node scripts/backfill-delivery-sellable.mjs [--prod] [--write]
 *
 * Dry-run by default. Until 30 Sep, saveDelivery created a brand-new SKU's
 * catalog row with wholesale_visible=false (and locked it), so a garment that
 * was received and in stock could not be added to an order — the order editor
 * and its save guard only accept sellable SKUs (Ansh: a new SKU from Log
 * delivery "shall be shown immediately"). New deliveries are fixed in code;
 * this repairs the rows already created.
 *
 * A row is repaired only when ALL of these hold:
 *   - wholesale_visible is false and locked (the lock Log delivery sets), and
 *     the SKU itself is not locked (renamed / custom-born rows are admin-owned),
 *   - Log delivery CREATED the catalog row: a receipt line with
 *     created_design=true names the SKU on a portal receipt (GR-YYYY-MM-DD-NNN,
 *     never GR-IMP-*), and the row's synced_at — stamped once by the delivery
 *     insert and never again, since the sheet does not carry these SKUs — is
 *     within 15 minutes of that receipt. A sheet-born design reordered through
 *     Log delivery also gets created_design=true, but its row predates the
 *     receipt, so this is what tells the two apart.
 *   - staff never hid it on purpose: the SKU's latest catalog_edit audit note
 *     is not "<SKU>: withdrawn from billing" (setProductSellable) or
 *     "<SKU>: hidden" (the pre-22-Sep visibility toggle).
 * The buyer catalog is a separate flag and is not touched: buyers still see
 * nothing until a Studio push. The lock is kept so the sheet cannot flip it.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const PROD = process.argv.includes("--prod");
const WRITE = process.argv.includes("--write");
dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true, quiet: true });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function all(table, cols, build = (q) => q) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build(admin.from(table).select(cols)).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const hidden = await all("wholesale_products", "sku, title, wholesale_price, current_qty, locked_fields, synced_at", (q) => q.eq("wholesale_visible", false).order("sku"));
const skus = hidden.map((h) => h.sku);
const lines = skus.length ? await all("goods_receipt_lines", "sku, created_design, receipt_id", (q) => q.in("sku", skus)) : [];
const receiptIds = [...new Set(lines.map((l) => l.receipt_id))];
const receipts = receiptIds.length ? await all("goods_receipts", "id, receipt_number, created_at", (q) => q.in("id", receiptIds)) : [];
const rById = new Map(receipts.map((r) => [r.id, r]));
const PORTAL = /^GR-\d{4}-\d{2}-\d{2}-\d{3}$/;
const minted = new Map();   // SKU -> the portal receipt whose line created its design
const imported = new Set(); // SKUs with any GR-IMP-* / old-format line
for (const l of lines) {
  const r = rById.get(l.receipt_id); const key = l.sku.toUpperCase();
  if (!r || !PORTAL.test(r.receipt_number)) { imported.add(key); continue; }
  if (l.created_design && !minted.has(key)) minted.set(key, r);
}

const audit = await all("auth_audit_log", "notes, event_at", (q) => q.eq("event_type", "catalog_edit").or("notes.ilike.%withdrawn from billing%,notes.ilike.%sellable at the counter%,notes.ilike.%: hidden%,notes.ilike.%: shown%").order("event_at"));
const lastToggle = new Map();
for (const a of audit) { const m = /^([A-Z0-9-]+): (withdrawn from billing|sellable at the counter|hidden|shown)\b/i.exec(a.notes ?? ""); if (m) lastToggle.set(m[1].toUpperCase(), m[2].toLowerCase()); }

const repair = [], skipped = [];
for (const h of hidden) {
  const key = h.sku.toUpperCase();
  const locks = Array.isArray(h.locked_fields) ? h.locked_fields : [];
  const r = minted.get(key);
  const createdByDelivery = !!r && !!h.synced_at && Math.abs(new Date(h.synced_at).getTime() - new Date(r.created_at).getTime()) < 15 * 60 * 1000;
  const toggle = lastToggle.get(key);
  const why =
    !locks.includes("wholesale_visible") ? "not locked (sheet-controlled)" :
    locks.includes("sku") ? "SKU is admin-owned (renamed or custom)" :
    imported.has(key) ? "has an imported / old-format receipt line" :
    !createdByDelivery ? "catalog row not created by Log delivery" :
    toggle === "withdrawn from billing" || toggle === "hidden" ? `staff ${toggle === "hidden" ? "hid" : "withdrew"} it on purpose` : null;
  if (why) skipped.push({ sku: h.sku, why }); else repair.push({ ...h, receipt: r.receipt_number });
}

console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"} · hidden rows: ${hidden.length} · to make sellable: ${repair.length} · left alone: ${skipped.length}`);
for (const r of repair) console.log(`  + ${r.sku.padEnd(24)} ${String(r.receipt).padEnd(18)} ₹${r.wholesale_price} · qty ${r.current_qty}${r.title ? ` · ${r.title.slice(0, 40)}` : ""}`);
const byWhy = {}; for (const s of skipped) (byWhy[s.why] ??= []).push(s.sku);
for (const [why, list] of Object.entries(byWhy)) console.log(`  – ${why}: ${list.length} (${list.slice(0, 8).join(" ")}${list.length > 8 ? " …" : ""})`);

if (!WRITE) { console.log("\n--write not given — nothing written."); process.exit(0); }
let done = 0; const failed = [];
for (const r of repair) {
  const { error } = await admin.from("wholesale_products").update({ wholesale_visible: true }).eq("sku", r.sku).eq("wholesale_visible", false);
  if (error) failed.push(`${r.sku}: ${error.message}`); else done++;
}
console.log(`\nmade sellable: ${done}/${repair.length}` + (failed.length ? `\nFAILED:\n  ${failed.join("\n  ")}` : ""));
process.exit(failed.length ? 1 : 0);
