import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { CATEGORIES, COLOR_GROUPS, SIZES } from "./vocab";

// Live vocabulary (Ansh's decision 5, 2 Aug): the static vocab remains the
// seed, and the editable `lovs` table extends or deactivates on top —
// Rakesh adds a colour in /admin/lovs and every minting surface offers it
// without a deploy. Server validation uses the SAME merged view, so a
// LoV-added code always mints.

export interface LiveVocab {
  categories: Record<string, { name: string; subs: Record<string, string> }>;
  colorGroups: { name: string; items: [string, string][] }[];
  sizes: Record<string, string>;
}

export async function loadVocab(): Promise<LiveVocab> {
  const admin = createAdminClient();
  const { data } = await admin.from("lovs").select("list, code, label, active");
  const rows = data ?? [];
  const off = (list: string) => new Set(rows.filter((r) => r.list === list && !r.active).map((r) => r.code.toUpperCase()));
  const on = (list: string) => rows.filter((r) => r.list === list && r.active);

  // Categories: static seed, LoV adds/relabels; deactivated ones drop.
  const categories: LiveVocab["categories"] = {};
  for (const [code, c] of Object.entries(CATEGORIES)) {
    categories[code] = { name: c.name, subs: { ...c.subs } };
  }
  for (const r of on("category")) {
    const code = r.code.toUpperCase();
    categories[code] = categories[code] ? { ...categories[code], name: r.label || categories[code].name } : { name: r.label || code, subs: { OTH: "Other" } };
  }
  for (const dead of off("category")) delete categories[dead];

  // Sub-categories: LoV codes are scoped "CAT-SUB".
  for (const r of on("sub_category")) {
    const [cat, sub] = r.code.toUpperCase().split("-");
    if (!cat || !sub) continue;
    if (!categories[cat]) categories[cat] = { name: cat, subs: {} };
    categories[cat].subs[sub] = r.label || sub;
  }
  for (const dead of off("sub_category")) {
    const [cat, sub] = dead.split("-");
    if (cat && sub && categories[cat]) delete categories[cat].subs[sub];
  }

  // Colours: static groups first; LoV-only codes join an "Added in portal" group.
  const staticCodes = new Set(COLOR_GROUPS.flatMap((g) => g.items.map(([c]) => c)));
  const deadColors = off("color");
  const colorGroups: LiveVocab["colorGroups"] = COLOR_GROUPS.map((g) => ({
    name: g.name,
    items: g.items.filter(([c]) => !deadColors.has(c)).map(([c, n]) => [c, n] as [string, string]),
  })).filter((g) => g.items.length > 0);
  const added = on("color").filter((r) => !staticCodes.has(r.code.toUpperCase()));
  if (added.length) {
    colorGroups.push({ name: "Added in portal", items: added.map((r) => [r.code.toUpperCase(), r.label || r.code] as [string, string]) });
  }

  // Sizes: static seed + LoV additions, minus deactivated.
  const sizes: Record<string, string> = { ...SIZES };
  for (const r of on("size")) sizes[r.code.toUpperCase()] = r.label || r.code;
  for (const dead of off("size")) delete sizes[dead];

  return { categories, colorGroups, sizes };
}

export async function validateCatSub(cat: string, sub: string): Promise<boolean> {
  const v = await loadVocab();
  return !!v.categories[cat] && sub in v.categories[cat].subs;
}

export async function validCodes(): Promise<{ colors: Set<string>; sizes: Set<string> }> {
  const v = await loadVocab();
  return {
    colors: new Set(v.colorGroups.flatMap((g) => g.items.map(([c]) => c))),
    sizes: new Set(Object.keys(v.sizes)),
  };
}
