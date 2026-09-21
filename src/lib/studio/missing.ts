// Which specs a design is still short of. PURE so vitest can load it, and
// shared so the board's filter chips and the loader agree on what "missing"
// means — a filter that disagreed with the field it names would be worse than
// no filter.
//
// Ansh, 22 Sep, right after 21 of 103 products reached Shopify in a single
// size: "add options to filter records by missing values in origin, Fabric,
// Color, etc". Origin is the one that bit — it picks the size ladder, and a
// design without it gets only the sizes physically in stock — but the same
// gap exists across the rest of the spec sheet and nothing surfaced it.

import { colorNameFor, type VocabLike } from "./facts";

/** Order is the chip order: what changes what reaches the store, then the
 *  descriptive fields. */
export const MISSING_FIELDS = [
  { key: "origin", label: "Origin" },
  { key: "retail_price", label: "Retail price" },
  { key: "wholesale_price", label: "Wholesale price" },
  { key: "fabric", label: "Fabric" },
  { key: "colour", label: "Colour name" },
  { key: "handwork", label: "Handwork" },
  { key: "category", label: "Category" },
  { key: "sub_category", label: "Sub-category" },
] as const;

export type MissingKey = (typeof MISSING_FIELDS)[number]["key"];

export const MISSING_KEYS: MissingKey[] = MISSING_FIELDS.map((f) => f.key);

export function isMissingKey(value: unknown): value is MissingKey {
  return typeof value === "string" && (MISSING_KEYS as string[]).includes(value);
}

export interface MissingInput {
  origin: string | null;
  fabric: string | null;
  handwork: string | null;
  /** The colour CODE (GLD), not the name. */
  color: string | null;
  colorName: string | null;
  category: string | null;
  subCategory: string | null;
  mrpOverride: number | null;
  autoMrp: number | null;
  /** From the wholesale group, not the design row. */
  wholesalePriceSet: boolean;
}

const blank = (v: string | null | undefined) => !(v ?? "").trim();

export function missingFields(d: MissingInput, vocab: VocabLike | null): MissingKey[] {
  const out: MissingKey[] = [];
  if (blank(d.origin)) out.push("origin");
  // Nothing gates on this today, so a design with no price pushes to Shopify
  // at 0.00. Worth being able to find.
  if (!(Number(d.mrpOverride ?? d.autoMrp ?? 0) > 0)) out.push("retail_price");
  if (!d.wholesalePriceSet) out.push("wholesale_price");
  if (blank(d.fabric)) out.push("fabric");
  // The CODE is not the name. A design carrying GLD with no color_name is not
  // missing a colour — the vocabulary answers "Gold", and that is what the
  // metafield and the title already use. One whose code the vocabulary has
  // never heard of genuinely is.
  if (blank(d.colorName) && !colorNameFor(d.color, vocab)) out.push("colour");
  if (blank(d.handwork)) out.push("handwork");
  if (blank(d.category)) out.push("category");
  if (blank(d.subCategory)) out.push("sub_category");
  return out;
}
