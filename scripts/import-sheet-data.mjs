/**
 * Productionization importers (Ansh's plan §2, 2 Aug 2026).
 *
 *   node scripts/import-sheet-data.mjs <vendors|lovs|receipts|master|all> [--write] [--prod]
 *
 * DRY-RUN by default — prints exactly what it WOULD do; --write commits.
 * Targets dev unless --prod. All idempotent: vendors upsert by name, lovs by
 * (list, code), receipts by an import ref, master fields fill per SKU/design.
 *
 * Sheet shapes (probed 2 Aug):
 *   Reference  paired columns, headers row 1, values row 2+:
 *              A/B category, D/E cat-sub key/name, G/H color, J fabrics,
 *              AB occasions, AD vendors
 *   Receipts   group header row 1, real headers row 2, data row 3+:
 *              SKU · Date (dd/mm/yyyy) · Type · Qty · Cost "₹3,800" · GST Type
 *              · Supplier · Vendor Invoice # · Notes · … · Entered By
 *   Master     read via the same header logic the sync uses.
 *
 * Receipts import NEVER touches the stock ledger: these are historical
 * deliveries whose quantities are already inside current_qty. They import as
 * records (grouped per supplier+date) so vendor history and costs are visible.
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "all";
const WRITE = args.includes("--write");
const target = args.includes("--prod") ? "prod" : "dev";
dotenv.config({ path: ".env.local" });
if (target === "dev") dotenv.config({ path: ".env.development.local", override: true });

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SHEET_ID = process.env.WHOLESALE_SHEET_ID || "1HnPYQRDwIxRTjgZ2ic8Bzfchidb1I5bbUdpO7Mbx8I8";
console.log(`Import ${cmd} → ${target.toUpperCase()} ${WRITE ? "· WRITE" : "· DRY-RUN (pass --write to commit)"}`);

async function sheetsApi() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const creds = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse((await import("node:fs")).readFileSync(raw, "utf8"));
  const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  return google.sheets({ version: "v4", auth });
}
async function readRange(range) {
  const sheets = await sheetsApi();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return r.data.values ?? [];
}
const money = (s) => { const n = parseFloat(String(s ?? "").replace(/[₹,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const ddmmyyyy = (s) => { const m = String(s ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };

// ── vendors (Reference!AD) ────────────────────────────────────────────────
async function importVendors() {
  const raw = (await readRange("Reference!AD2:AD100")).flat().map((v) => String(v).trim()).filter(Boolean);
  // The sheet list carries case-duplicates ("Pravni"/"pravni") — first spelling wins.
  const seen = new Set();
  const col = raw.filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  // Master's per-SKU Vendor Name is the canonical vendor source (Ansh, 2 Aug)
  // — already synced into product_vendor_info, so read it from there.
  const { data: pvi } = await db.from("product_vendor_info").select("vendor_name").not("vendor_name", "is", null);
  for (const r of pvi ?? []) {
    const n = String(r.vendor_name).trim();
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); col.push(n); }
  }
  const { data: existing } = await db.from("vendors").select("id, name");
  const have = new Set((existing ?? []).map((v) => v.name.trim().toLowerCase()));
  const missing = col.filter((n) => !have.has(n.toLowerCase()));
  console.log(`vendors: sheet+master ${col.length} · portal ${have.size} · to create ${missing.length}${missing.length ? " → " + missing.join(", ") : ""}`);
  if (!WRITE) return;
  for (const name of missing) {
    const { error } = await db.from("vendors").insert({ name });
    console.log(`  + ${name} ${error ? "FAILED " + error.message : "ok"}`);
  }
}

// ── lovs (Reference paired columns + standard sizes) ──────────────────────
async function importLovs() {
  const rows = await readRange("Reference!A2:AB200");
  const take = (ci, li = null) =>
    rows.map((r) => ({ code: String(r[ci] ?? "").trim(), label: String(r[li ?? ci] ?? "").trim() })).filter((x) => x.code);
  const lists = {
    category: take(0, 1),
    sub_category: take(3, 4), // full cat-sub key keeps the scoping (SAR-TRD)
    color: take(6, 7),
    fabric: take(9),
    occasion: take(27),
    size: ["S", "M", "L", "XL", "XXL", "FS"].map((c) => ({ code: c, label: c })), // not in Reference — house standard
  };
  for (const [list, values] of Object.entries(lists)) {
    const seen = new Set();
    const rows2 = values.filter((v) => { const k = v.code.toUpperCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    console.log(`lovs/${list}: ${rows2.length} value(s)`);
    if (!WRITE) continue;
    for (const [i, v] of rows2.entries()) {
      const { error } = await db.from("lovs").upsert(
        { list, code: v.code.toUpperCase().slice(0, 24), label: v.label || v.code, sort: i, active: true },
        { onConflict: "list,code" },
      );
      if (error) console.log(`  ${list}:${v.code} FAILED ${error.message}`);
    }
  }
}

// ── receipts (Receipts!A3+) — history only, NO ledger writes ─────────────
async function importReceipts() {
  // Vendor fallback: Master's per-SKU Vendor Name (synced into
  // product_vendor_info). A Receipts row's own supplier wins when present.
  const { data: pvi } = await db.from("product_vendor_info").select("sku, vendor_name");
  const vendorBySku = new Map((pvi ?? []).filter((r) => r.vendor_name?.trim()).map((r) => [r.sku.toUpperCase(), r.vendor_name.trim()]));

  const rows = await readRange("Receipts!A3:O2000");
  const dropped = [];
  const lines = rows
    .map((r, i) => ({
      row: i + 3,
      sku: String(r[0] ?? "").trim().toUpperCase(),
      date: ddmmyyyy(r[1]),
      type: String(r[2] ?? "").trim(),
      // Blank qty means "no mention" → 1 piece (Ansh, 3 Aug). An explicit 0
      // stays 0 and is still reported as a gap.
      qty: String(r[3] ?? "").trim() === "" ? 1 : parseInt(String(r[3]).replace(/[^\d]/g, ""), 10) || 0,
      cost: money(r[4]),
      gstType: String(r[5] ?? "").trim(),
      supplier: String(r[6] ?? "").trim(),
      invoiceNo: String(r[7] ?? "").trim(),
      notes: String(r[8] ?? "").trim(),
      enteredBy: String(r[13] ?? "").trim(),
      gstRate: money(r[14]) || null,
    }))
    .map((l) => (l.supplier ? l : { ...l, supplier: vendorBySku.get(l.sku) ?? "", supplierFromMaster: true }))
    .filter((l) => {
      if (!l.sku) return false; // truly empty row
      if (l.qty <= 0) { dropped.push(`row ${l.row} ${l.sku}: blank/zero qty`); return false; }
      if (!l.supplier) { dropped.push(`row ${l.row} ${l.sku}: no supplier on the row AND no Vendor Name in Master`); return false; }
      return true;
    });

  // Group into one receipt per supplier + date + invoice number.
  const groups = new Map();
  for (const l of lines) {
    if (!l.supplier) continue; // a handful of sheet rows have no supplier — unattributable, skip
    const key = `${l.supplier.toLowerCase()}|${l.date}|${l.invoiceNo}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const { data: vendors } = await db.from("vendors").select("id, name");
  const vByName = new Map((vendors ?? []).map((v) => [v.name.trim().toLowerCase(), v.id]));
  const { data: existing } = await db.from("goods_receipts").select("client_ref").not("client_ref", "is", null);
  const haveRefs = new Set((existing ?? []).map((r) => r.client_ref));

  // client_ref is a UUID column — derive a stable UUID from the group key so
  // re-runs skip exactly the groups already imported.
  const refFor = (key) => {
    const h = createHash("sha1").update(`sheet-import:${key}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  let create = 0, skip = 0, topped = 0;
  const noVendor = new Set();
  for (const [key, ls] of groups) {
    const ref = refFor(key);
    if (haveRefs.has(ref)) {
      // Group already imported — but rows recovered later (e.g. supplier now
      // resolved from Master) must still JOIN their receipt, not vanish.
      const { data: rec } = await db.from("goods_receipts").select("id").eq("client_ref", ref).maybeSingle();
      if (rec) {
        const { data: haveLines } = await db.from("goods_receipt_lines").select("sku").eq("receipt_id", rec.id);
        const present = new Set((haveLines ?? []).map((l) => l.sku.toUpperCase()));
        const add = ls.filter((l) => !present.has(l.sku));
        if (add.length) {
          topped += add.length;
          if (WRITE) {
            const { error } = await db.from("goods_receipt_lines").insert(
              add.map((l) => ({ receipt_id: rec.id, sku: l.sku, description: l.notes || l.type, qty: l.qty, unit_cost: l.cost })),
            );
            if (error) console.log(`  top-up ${key} FAILED ${error.message}`);
          }
        }
      }
      skip++;
      continue;
    }
    const vId = vByName.get(ls[0].supplier.toLowerCase());
    if (!vId) { noVendor.add(ls[0].supplier); continue; }
    create++;
    if (!WRITE) continue;
    const isPakka = /pakka/i.test(ls[0].gstType);
    const { data: rec, error } = await db
      .from("goods_receipts")
      .insert({
        receipt_number: `GR-IMP-${ref.slice(0, 8).toUpperCase()}`,
        vendor_id: vId,
        receipt_date: ls[0].date ?? "2026-07-01",
        bill_amount: null,
        gst_mode: ls[0].gstType ? (isPakka ? "pakka" : "kaccha") : null,
        gst_rate: isPakka ? ls[0].gstRate ?? 5 : null,
        gst_inclusive: isPakka ? true : null, // sheet never recorded this — default inclusive, editable
        notes: `Imported from Wholesale sheet Receipts tab${ls[0].invoiceNo ? ` · invoice ${ls[0].invoiceNo}` : ""}`,
        client_ref: ref,
        created_by: ls[0].enteredBy ? `${ls[0].enteredBy}@drevifashion.com` : "sheet-import",
      })
      .select("id")
      .single();
    if (error) { console.log(`  ${key} FAILED ${error.message}`); continue; }
    const { error: lErr } = await db.from("goods_receipt_lines").insert(
      ls.map((l) => ({ receipt_id: rec.id, sku: l.sku, description: l.notes || l.type, qty: l.qty, unit_cost: l.cost })),
    );
    if (lErr) console.log(`  ${key} lines FAILED ${lErr.message}`);
  }
  console.log(`receipts: ${lines.length} line(s) in ${groups.size} group(s) · to create ${create} · already imported ${skip} · lines topped up into existing receipts ${topped}`);
  if (dropped.length) {
    console.log(`  ⚠ ${dropped.length} sheet row(s) SKIPPED — fix the cells and re-run (idempotent):`);
    for (const d of dropped) console.log(`    ${d}`);
  }
  if (noVendor.size) console.log(`  ⚠ suppliers not in vendors table (run vendors first): ${[...noVendor].join(", ")}`);
  console.log("  NOTE: no stock movements written — history only; current stock already includes these.");
}

// ── master extra columns ──────────────────────────────────────────────────
async function importMaster() {
  const values = await readRange("Master!A1:CZ2000");
  const h1 = values[0] ?? [], h2 = values[1] ?? [];
  const headers = h1.map((v, i) => String(h2[i] ?? "").trim() || String(v ?? "").trim());
  const col = (name) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const C = {
    sku: col("SKU") >= 0 ? col("SKU") : col("Drevi SKU"),
    secFabric: col("Secondary Fabric"),
    secHandwork: col("Secondary Handwork"),
    autoMrp: col("Auto MRP"),
    mrpOverride: col("MRP Override"),
    autoWholesale: col("Auto Wholesale"),
    wholesaleOverride: col("Wholesale Override"),
    occasionHints: col("Rakesh's Occasion Hints"),
    productName: col("Product Name"),
    description: col("Description"),
    metaTitle: col("Meta Title"),
    metaDescription: col("Meta Description"),
    copyGeneratedAt: col("Copy Generated At"),
  };
  console.log("master column map:", JSON.stringify(C));
  if (C.sku < 0) { console.log("  ⚠ no SKU column found — aborting master import"); return; }

  const { data: designs } = await db.from("designs").select("id, base_sku, color");
  const designByKey = new Map((designs ?? []).map((d) => [`${d.base_sku}|${d.color.toUpperCase()}`, d.id]));
  let perSku = 0, perDesign = 0, unmatchedDesign = 0;
  const doneDesigns = new Set();

  for (const row of values.slice(2)) {
    const sku = String(row[C.sku] ?? "").trim().toUpperCase();
    if (!sku) continue;
    const v = (i) => (i >= 0 ? String(row[i] ?? "").trim() : "");

    // per-SKU pricing provenance
    const patch = {};
    if (C.autoMrp >= 0 && money(v(C.autoMrp))) patch.auto_mrp = money(v(C.autoMrp));
    if (C.mrpOverride >= 0 && money(v(C.mrpOverride))) patch.mrp_override = money(v(C.mrpOverride));
    if (C.autoWholesale >= 0 && money(v(C.autoWholesale))) patch.auto_wholesale = money(v(C.autoWholesale));
    if (C.wholesaleOverride >= 0 && money(v(C.wholesaleOverride))) patch.wholesale_override = money(v(C.wholesaleOverride));
    if (Object.keys(patch).length) {
      perSku++;
      if (WRITE) await db.from("wholesale_products").update(patch).eq("sku", sku);
    }

    // per-design copy/spec fields — first row of a design wins
    const parts = sku.split("-");
    if (parts.length >= 6) {
      const key = `${parts.slice(0, 4).join("-")}|${parts[parts.length - 1]}`;
      if (!doneDesigns.has(key)) {
        doneDesigns.add(key);
        const designId = designByKey.get(key);
        if (!designId) { unmatchedDesign++; }
        else {
          const dPatch = {};
          if (v(C.secFabric)) dPatch.secondary_fabric = v(C.secFabric);
          if (v(C.secHandwork)) dPatch.secondary_handwork = v(C.secHandwork);
          if (v(C.occasionHints)) dPatch.occasion_hints = v(C.occasionHints);
          if (v(C.metaTitle)) dPatch.meta_title = v(C.metaTitle);
          if (v(C.metaDescription)) dPatch.meta_description = v(C.metaDescription);
          if (Object.keys(dPatch).length) {
            perDesign++;
            if (WRITE) await db.from("designs").update(dPatch).eq("id", designId);
          }
          // copy: only fill when the portal has none — the studio owns it after cutover
          if (v(C.productName) || v(C.description)) {
            const { data: existing } = await db.from("design_copy").select("design_id, title").eq("design_id", designId).maybeSingle();
            if (!existing?.title && WRITE) {
              await db.from("design_copy").upsert(
                {
                  design_id: designId,
                  title: v(C.productName)?.slice(0, 120) || null,
                  description: v(C.description) || null,
                  status: "draft",
                  model: "sheet-import",
                  generated_at: v(C.copyGeneratedAt) ? new Date(v(C.copyGeneratedAt)).toISOString() : null,
                },
                { onConflict: "design_id" },
              );
            }
          }
        }
      }
    }
  }
  console.log(`master: pricing patched on ${perSku} SKU(s) · design fields on ${perDesign} design(s) · designs not in portal: ${unmatchedDesign}`);
}

const run = { vendors: importVendors, lovs: importLovs, receipts: importReceipts, master: importMaster };
if (cmd === "all") {
  for (const k of ["vendors", "lovs", "receipts", "master"]) { console.log(`\n── ${k} ──`); await run[k](); }
} else if (run[cmd]) {
  await run[cmd]();
} else {
  console.error(`Unknown command "${cmd}". Use vendors | lovs | receipts | master | all.`);
  process.exit(1);
}
console.log("\nDone.");
