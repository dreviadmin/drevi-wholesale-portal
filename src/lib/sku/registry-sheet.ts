import "server-only";

import { readFileSync } from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

// Legacy SKU registry sheet interop (transition safety, spec §4).
// - importer: sheet -> Supabase (rows minted via the old Apps Script tool)
// - mirror:   Supabase -> sheet (portal rows, so the old tool's counters see them)
// - floor:    live max design number per CAT-SUB from the sheet (dual mode)
//
// Single header row, columns A–J:
// Timestamp | Base SKU | Variant SKU | Category | Sub-Category | Color | Size | Description | Created By | QR Code

const SHEET_ID = () => process.env.SKU_REGISTRY_SHEET_ID ?? "1-Gnqoq5g82R3w4g-Mo6zI0NBBlCB9Ib2bkoWpEHmZ4s";
const TAB = () => process.env.SKU_REGISTRY_TAB ?? "SKUs";
export const dualMode = () => (process.env.SKU_DUAL_MODE ?? "true").toLowerCase() !== "false";

let client: sheets_v4.Sheets | null = null;
async function getSheets(): Promise<sheets_v4.Sheets> {
  if (client) return client;
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const json = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  const sa = JSON.parse(json) as { client_email?: string; private_key?: string };
  if (!sa.client_email || !sa.private_key) throw new Error("service account missing client_email / private_key");
  // Write scope — the mirror appends rows (the account needs Editor on this sheet).
  const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  await auth.authorize();
  client = google.sheets({ version: "v4", auth });
  return client;
}

interface SheetRow {
  timestamp: string; base: string; variant: string; cat: string; sub: string;
  color: string; size: string; description: string; createdBy: string; qrUrl: string;
}

async function readAllRows(): Promise<SheetRow[]> {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${TAB()}!A2:J`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return ((res.data.values ?? []) as string[][]).map((r) => ({
    timestamp: (r[0] ?? "").toString().trim(),
    base: (r[1] ?? "").toString().trim().toUpperCase(),
    variant: (r[2] ?? "").toString().trim().toUpperCase(),
    cat: (r[3] ?? "").toString().trim().toUpperCase(),
    sub: (r[4] ?? "").toString().trim().toUpperCase(),
    color: (r[5] ?? "").toString().trim().toUpperCase(),
    size: (r[6] ?? "").toString().trim().toUpperCase(),
    description: (r[7] ?? "").toString().trim(),
    createdBy: (r[8] ?? "").toString().trim(),
    qrUrl: (r[9] ?? "").toString().trim(),
  }));
}

function parseSheetTimestamp(s: string): string | null {
  if (!s) return null;
  // Sheet stamps are 'yyyy-MM-dd HH:mm:ss' in IST (Apps Script), but legacy
  // rows vary — best-effort parse, approximate created_at is acceptable.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}+05:30` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deriveParts(variant: string, base: string) {
  // variant = DD-CAT-SUB-NNN-SIZE-COLOR; base = DD-CAT-SUB-NNN. Either may be
  // blank on messy legacy rows — derive what we can.
  const b = base || variant.split("-").slice(0, 4).join("-");
  const parts = b.split("-");
  const rest = variant.startsWith(b + "-") ? variant.slice(b.length + 1).split("-") : [];
  return {
    base: b,
    cat: parts[1] ?? "",
    sub: parts[2] ?? "",
    size: rest[0] ?? "",
    color: rest.slice(1).join("-") || rest[0] || "",
  };
}

// §4.1 Importer — idempotent; first run is the full historical backfill.
export async function importRegistry(): Promise<{ imported: number; qrBackfilled: number; warnings: string[] }> {
  const warnings: string[] = [];
  const admin = createAdminClient();
  const rows = await readAllRows();

  const existing = await fetchAll<{ variant_sku: string; qr_url: string | null }>(admin, "sku_registry", "variant_sku, qr_url");
  const byVariant = new Map(existing.map((r) => [r.variant_sku.toUpperCase(), r]));

  const toInsert: Record<string, unknown>[] = [];
  const qrFills: { variant: string; qr: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const variant = r.variant || r.base;
    if (!variant || seen.has(variant)) continue;
    seen.add(variant);
    const ex = byVariant.get(variant);
    if (ex) {
      if (!ex.qr_url && r.qrUrl) qrFills.push({ variant, qr: r.qrUrl });
      continue;
    }
    const d = deriveParts(variant, r.base);
    toInsert.push({
      base_sku: d.base,
      variant_sku: variant,
      category: r.cat || d.cat,
      sub_category: r.sub || d.sub,
      color: r.color || d.color,
      size: r.size || d.size,
      description: r.description,
      created_by: r.createdBy || "sheet",
      created_at: parseSheetTimestamp(r.timestamp) ?? new Date().toISOString(),
      qr_url: r.qrUrl || null,
      source: "sheet_import",
      sheet_synced: true,
    });
  }

  let imported = 0;
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const { error } = await admin.from("sku_registry").insert(chunk);
    if (error) {
      // A concurrent mint can collide on the unique index — retry row-by-row.
      for (const row of chunk) {
        const { error: one } = await admin.from("sku_registry").insert(row);
        if (!one) imported++;
        else if (one.code !== "23505") warnings.push(`import ${row.variant_sku}: ${one.message}`);
      }
    } else {
      imported += chunk.length;
    }
  }

  let qrBackfilled = 0;
  for (const f of qrFills) {
    const { error } = await admin.from("sku_registry").update({ qr_url: f.qr }).eq("variant_sku", f.variant).is("qr_url", null);
    if (!error) qrBackfilled++;
  }

  return { imported, qrBackfilled, warnings };
}

// §4.2 Mirror — append portal rows the old tool hasn't seen yet.
export async function mirrorRegistry(): Promise<{ mirrored: number; warnings: string[] }> {
  const warnings: string[] = [];
  const admin = createAdminClient();
  const { data: pending, error } = await admin
    .from("sku_registry")
    .select("id, base_sku, variant_sku, category, sub_category, color, size, description, created_by, created_at")
    .eq("source", "portal")
    .eq("sheet_synced", false)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`mirror read failed: ${error.message}`);
  if (!pending || pending.length === 0) return { mirrored: 0, warnings };

  const fmt = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    // Asia/Kolkata = UTC+5:30, no DST.
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
  };
  const values = pending.map((r) => [
    fmt(r.created_at), r.base_sku, r.variant_sku, r.category, r.sub_category,
    r.color, r.size, r.description ?? "", r.created_by, "", // QR Code blank — QRs are no longer stored
  ]);

  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${TAB()}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  const ids = pending.map((r) => r.id);
  const { error: upErr } = await admin.from("sku_registry").update({ sheet_synced: true }).in("id", ids);
  if (upErr) warnings.push(`mirror flag update failed: ${upErr.message}`);
  return { mirrored: pending.length, warnings };
}

// Mirror a single just-minted row inline (best-effort — the cron retries).
export async function mirrorOne(variantSku: string): Promise<void> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("sku_registry")
    .select("id, base_sku, variant_sku, category, sub_category, color, size, description, created_by, created_at")
    .eq("variant_sku", variantSku)
    .eq("sheet_synced", false)
    .maybeSingle();
  if (!row) return;
  const sheets = await getSheets();
  const d = new Date(row.created_at);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${TAB()}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[ts, row.base_sku, row.variant_sku, row.category, row.sub_category, row.color, row.size, row.description ?? "", row.created_by, ""]] },
  });
  await admin.from("sku_registry").update({ sheet_synced: true }).eq("id", row.id);
}

// §4.3 Dual-mode floor — the sheet's max design number for CAT-SUB. Never
// blocks minting: any Sheets error returns 0 with a warning.
export async function sheetNumberFloor(cat: string, sub: string): Promise<{ floor: number; warning?: string }> {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID(),
      range: `${TAB()}!B2:B`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const prefix = `DD-${cat}-${sub}-`;
    let max = 0;
    for (const r of (res.data.values ?? []) as string[][]) {
      const v = (r[0] ?? "").toString().trim().toUpperCase();
      if (!v.startsWith(prefix)) continue;
      const m = v.match(/(\d{3})$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return { floor: max };
  } catch (err) {
    return { floor: 0, warning: `sheet floor unavailable: ${(err as Error).message}` };
  }
}

// Third floor source: the RETAIL pipeline Master ("Drevi Product Master",
// ~1000 rows the service account can already read). The registry sheet needs
// an operator grant the portal may not have yet — but every LIVE design is in
// this Master, so its floor alone stops re-minting numbers of real garments
// for categories that never entered the wholesale tables. Cached briefly:
// mints come in bursts while tagging a delivery.
const RETAIL_MASTER_ID = () => process.env.PIPELINE_MASTER_SHEET_ID ?? "1FbI2SBWqBC6Wy8oTLtModXXvDKHbpIdQPRO32g2ivr0";
let masterSkuCache: { at: number; skus: string[] } | null = null;
const MASTER_CACHE_MS = 5 * 60 * 1000;

export async function masterNumberFloor(cat: string, sub: string): Promise<{ floor: number; warning?: string }> {
  try {
    if (!masterSkuCache || Date.now() - masterSkuCache.at > MASTER_CACHE_MS) {
      const { readMaster } = await import("@/lib/sheets");
      const { rows } = await readMaster({ sku: "Drevi SKU" }, RETAIL_MASTER_ID());
      masterSkuCache = { at: Date.now(), skus: rows.map((r) => (r.sku ?? "").trim().toUpperCase()).filter(Boolean) };
    }
    const re = new RegExp(`^DD-${cat}-${sub}-(\\d{3})`);
    let max = 0;
    for (const s of masterSkuCache.skus) {
      const m = s.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return { floor: max };
  } catch (err) {
    masterSkuCache = null;
    return { floor: 0, warning: `retail master floor unavailable: ${(err as Error).message}` };
  }
}

// Defence-in-depth floor from the portal's OWN product tables: until the
// registry backfill has run (sheet access is an operator step), the legacy
// SKUs already live in wholesale_products / product_vendor_info — never mint
// below them. Cheap (two indexed LIKE reads) and kept on permanently.
export async function knownSkuFloor(cat: string, sub: string): Promise<number> {
  const admin = createAdminClient();
  const prefix = `DD-${cat}-${sub}-%`;
  const [a, b] = await Promise.all([
    admin.from("wholesale_products").select("sku").like("sku", prefix),
    admin.from("product_vendor_info").select("sku").like("sku", prefix),
  ]);
  let max = 0;
  for (const r of [...(a.data ?? []), ...(b.data ?? [])]) {
    const m = (r.sku as string).match(new RegExp(`^DD-${cat}-${sub}-(\\d{3})`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}
