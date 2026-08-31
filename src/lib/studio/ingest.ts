import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ALL_ANGLES } from "./state";

// Studio ingest (build guide §7.3): for every synced product row, parse
// DD-CAT-SUB-NNN-SIZE-COLOR, upsert the (base, color) design with its
// sheet-mirror fields, and ensure the 6 design_angles rows plus the two
// publish_targets rows exist. Idempotent, additive; NEVER touches
// specs_verified, tier, or any studio-owned state on existing designs.

interface IngestRow {
  sku: string;
  title: string | null;
  category: string | null;
  sub_category: string | null;
  primary_fabric?: string | null;
}

function parseSku(sku: string): { base: string; color: string } | null {
  const parts = sku.trim().toUpperCase().split("-");
  // Positional design number (same rule as the Drive photo chain).
  if (parts[0] !== "DD" || parts.length < 5 || !/^\d{2,4}$/.test(parts[3])) return null;
  return { base: parts.slice(0, 4).join("-"), color: parts[parts.length - 1] };
}

export async function ingestDesigns(
  admin: SupabaseClient,
  rows: IngestRow[],
  warnings: string[],
): Promise<{ designs: number; created: number }> {
  // Group variants into designs; first row of a group supplies the mirror fields.
  const groups = new Map<string, { base: string; color: string; row: IngestRow }>();
  let unparseable = 0;
  for (const r of rows) {
    const p = parseSku(r.sku);
    if (!p) { unparseable++; continue; }
    const key = `${p.base}|${p.color}`;
    if (!groups.has(key)) groups.set(key, { ...p, row: r });
  }
  if (unparseable > 0) warnings.push(`Studio ingest: ${unparseable} SKU(s) not in DD-CAT-SUB-NNN-… form, skipped.`);
  if (groups.size === 0) return { designs: 0, created: 0 };

  const { data: before, error: beforeErr } = await admin.from("designs").select("id");
  if (beforeErr) { warnings.push(`Studio ingest skipped — designs read failed: ${beforeErr.message}`); return { designs: 0, created: 0 }; }

  // Upsert mirror fields only — absent columns are untouched on conflict.
  const payload = [...groups.values()].map(({ base, color, row }) => ({
    base_sku: base,
    color,
    title: row.title ?? null,
    category: row.category ?? null,
    sub_category: row.sub_category ?? null,
    fabric: row.primary_fabric ?? null,
  }));
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await admin.from("designs").upsert(payload.slice(i, i + 200), { onConflict: "base_sku,color" });
    if (error) { warnings.push(`Studio ingest upsert failed: ${error.message}`); return { designs: 0, created: 0 }; }
  }

  // Ensure angle + target scaffolding for every design.
  const { data: designs, error: dErr } = await admin.from("designs").select("id");
  if (dErr || !designs) { warnings.push(`Studio ingest: post-upsert read failed: ${dErr?.message}`); return { designs: 0, created: 0 }; }

  const [{ data: angleRows }, { data: targetRows }] = await Promise.all([
    admin.from("design_angles").select("design_id, angle"),
    admin.from("publish_targets").select("design_id, portal"),
  ]);
  const haveAngle = new Set((angleRows ?? []).map((a) => `${a.design_id}|${a.angle}`));
  const haveTarget = new Set((targetRows ?? []).map((t) => `${t.design_id}|${t.portal}`));

  const newAngles: { design_id: string; angle: string }[] = [];
  const newTargets: { design_id: string; portal: string }[] = [];
  for (const d of designs) {
    for (const angle of ALL_ANGLES) if (!haveAngle.has(`${d.id}|${angle}`)) newAngles.push({ design_id: d.id, angle });
    for (const portal of ["wholesale", "shopify"]) if (!haveTarget.has(`${d.id}|${portal}`)) newTargets.push({ design_id: d.id, portal });
  }
  for (let i = 0; i < newAngles.length; i += 500) {
    const { error } = await admin.from("design_angles").insert(newAngles.slice(i, i + 500));
    if (error) warnings.push(`Studio ingest angles insert: ${error.message}`);
  }
  for (let i = 0; i < newTargets.length; i += 500) {
    const { error } = await admin.from("publish_targets").insert(newTargets.slice(i, i + 500));
    if (error) warnings.push(`Studio ingest targets insert: ${error.message}`);
  }

  return { designs: designs.length, created: designs.length - (before?.length ?? 0) };
}
