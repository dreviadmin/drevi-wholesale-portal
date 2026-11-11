// The PURE half of the studio ingest (ingest.ts): which sheet-mirror values a
// design row is written with. No server-only imports, so tests can use it.

export interface DesignMirror {
  title: string | null;
  category: string | null;
  sub_category: string | null;
  fabric: string | null;
}

function hasValue(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * The mirror fields the sheet sync upserts onto one (base, colour) design
 * (audit round 2, 4 Oct).
 *
 * Since the 31 Aug cutover the portal owns specs: the Product Master writes
 * designs.fabric (saveSpecs), and copy prompts and the Shopify custom.fabric
 * fallback read it. Ingest used to upsert the sheet's values over every
 * sheet-born design each ten minutes, so a fabric Rakesh typed in the Product
 * Master over a blank "Primary Fabric" cell came back null on the next sync.
 * Now the sheet only FILLS a blank: a field the design already holds is
 * written back unchanged, whatever the sheet says. A brand-new design (no
 * existing row) takes the sheet's values exactly as before.
 *
 * Every key is always present in the result: PostgREST unifies columns across
 * a bulk upsert, so a key missing on one row would null that column instead.
 */
export function mergeSheetMirror(existing: Partial<DesignMirror> | undefined, sheet: DesignMirror): DesignMirror {
  // Blank on both sides keeps what is there (no churn on an existing row).
  const fill = (portal: string | null | undefined, fromSheet: string | null): string | null =>
    hasValue(portal) ? portal : hasValue(fromSheet) ? fromSheet : portal ?? fromSheet ?? null;
  return {
    title: fill(existing?.title, sheet.title),
    category: fill(existing?.category, sheet.category),
    sub_category: fill(existing?.sub_category, sheet.sub_category),
    fabric: fill(existing?.fabric, sheet.fabric),
  };
}
