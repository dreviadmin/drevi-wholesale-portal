import "server-only";

import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { getEnv } from "@/lib/env";

// Reads the Product Master Sheet. The Master tab uses a TWO-ROW header:
// row 1 = section labels (carried forward across blank cells), row 2 = field
// names. They are joined into "Section/Field" effective headers and matched by
// suffix — mirroring the pipeline (drevi_common.py) so header reformatting
// doesn't break the sync. Data starts at row 3.

const MASTER_TAB = "Master";

function loadServiceAccount(): { client_email: string; private_key: string } {
  const raw = getEnv("GOOGLE_SERVICE_ACCOUNT_JSON").trim();
  const json = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email / private_key.");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

async function getSheetsApi() {
  const sa = loadServiceAccount();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

/** 1-indexed column lookup. Mirrors the pipeline's find_column(). */
export function findColumn(headers: string[], needle: string): number {
  const n = (needle ?? "").trim();
  if (!n) return 0;
  for (let i = 0; i < headers.length; i++) if (headers[i] === n) return i + 1; // exact
  const suffix = "/" + n;
  for (let i = 0; i < headers.length; i++) if (headers[i]?.endsWith(suffix)) return i + 1; // suffix
  if (n.includes("/")) {
    let idx = n.indexOf("/");
    while (idx >= 0) {
      const sub = n.slice(idx + 1).trim();
      for (let i = 0; i < headers.length; i++) if (headers[i] === sub) return i + 1;
      idx = n.indexOf("/", idx + 1);
    }
  }
  return 0;
}

/** Join row1 (sections, carried forward) + row2 (field names) into effective headers. */
export function buildEffectiveHeaders(row1: string[], row2: string[]): string[] {
  const width = Math.max(row1.length, row2.length);
  const out: string[] = [];
  let section = "";
  for (let i = 0; i < width; i++) {
    const s = (row1[i] ?? "").trim();
    if (s) section = s;
    const col = (row2[i] ?? "").trim();
    if (!col) out.push("");
    else out.push(section ? `${section}/${col}` : col);
  }
  return out;
}

export interface MasterReadResult {
  effectiveHeaders: string[];
  /** logicalKey -> 1-indexed column number (0 = not found) */
  resolved: Record<string, number>;
  /** missing required-or-requested logical keys */
  missing: string[];
  /** each data row keyed by logical key; absent columns yield "" */
  rows: Array<Record<string, string>>;
}

/**
 * Read every data row from the Master tab, resolving each logical key in `cols`
 * (logicalKey -> display header) to a column via suffix matching.
 * `spreadsheetId` defaults to the pipeline Master (GOOGLE_SHEET_ID); the sync
 * also reads the Wholesale Master with the same structure.
 */
export async function readMaster(cols: Record<string, string>, spreadsheetId?: string): Promise<MasterReadResult> {
  const sheets = await getSheetsApi();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId ?? getEnv("GOOGLE_SHEET_ID"),
    range: MASTER_TAB,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const values = (res.data.values ?? []) as string[][];
  const row1 = values[0] ?? [];
  const row2 = values[1] ?? [];
  const effectiveHeaders = buildEffectiveHeaders(row1, row2);

  const resolved: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, header] of Object.entries(cols)) {
    const col = findColumn(effectiveHeaders, header);
    resolved[key] = col;
    if (col === 0) missing.push(key);
  }

  const rows: Array<Record<string, string>> = [];
  for (let r = 2; r < values.length; r++) {
    const raw = values[r] ?? [];
    const row: Record<string, string> = {};
    for (const [key, col] of Object.entries(resolved)) {
      row[key] = col > 0 ? (raw[col - 1] ?? "").toString().trim() : "";
    }
    rows.push(row);
  }

  return { effectiveHeaders, resolved, missing, rows };
}
