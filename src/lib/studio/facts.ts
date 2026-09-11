import type { PromptDesign } from "./prompts";

// Code → human-name resolution for prompts and labels. Pure: the vocabulary is
// passed in (loadVocab() from sku/vocab-live is structurally a VocabLike), so
// this module stays free of server-only and supabase imports and vitest can
// load it. designs.category / sub_category / color keep storing CODES — SKU
// minting, sync and the publish keys depend on them; only the prose changes.

export interface VocabLike {
  categories: Record<string, { name: string; subs: Record<string, string> }>;
  colorGroups: { name: string; items: [string, string][] }[];
}

export interface DesignFactsInput {
  category?: string | null;
  subCategory?: string | null;
  color?: string | null;
  /** designs.color_name — staff free text, always beats the vocab name. */
  colorName?: string | null;
}

export interface DesignFacts {
  categoryCode: string | null;
  /** The vocab name, or the raw value untouched when it does not resolve. */
  categoryName: string | null;
  subCategoryCode: string | null;
  subCategoryName: string | null;
  colorCode: string | null;
  /** Free text > vocab name > null. */
  colorName: string | null;
}

/** One object that satisfies both prompts.PromptDesign and copy PromptFacts. */
export interface ResolvedPromptDesign extends PromptDesign {
  categoryCode: string | null;
  subCategoryCode: string | null;
  origin?: string | null;
  tier?: string | null;
  bgSeed: string;
}

export interface DesignRowLike {
  title?: string | null;
  category?: string | null;
  sub_category?: string | null;
  color?: string | null;
  color_name?: string | null;
  fabric?: string | null;
  handwork?: string | null;
  origin?: string | null;
  tier?: string | null;
  bg_style?: string | null;
  base_sku?: string | null;
}

const key = (v?: string | null): string | null => (v ?? "").trim().toUpperCase() || null;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function colorNameFor(code: string | null | undefined, vocab: VocabLike | null): string | null {
  const c = key(code);
  if (!c || !vocab) return null;
  for (const g of vocab.colorGroups) for (const [k, n] of g.items) if (k.toUpperCase() === c) return n;
  return null;
}

export function describeDesignFacts(d: DesignFactsInput, vocab: VocabLike | null): DesignFacts {
  // Lookups key on the uppercased value; the raw value passes through verbatim
  // when nothing matches (sheet-born designs hold names like "Sarees").
  const rawCat = d.category?.trim() || null;
  const rawSub = d.subCategory?.trim() || null;
  const catKey = key(rawCat);
  const catEntry = vocab && catKey && own(vocab.categories, catKey) ? vocab.categories[catKey] : undefined;
  // Sub-codes repeat across categories (OTH, FLR, ALN…) — resolve only through the parent.
  const subKey = key(rawSub);
  const subName = catEntry && subKey && own(catEntry.subs, subKey) ? catEntry.subs[subKey] : undefined;
  const colorCode = key(d.color);
  return {
    categoryCode: catEntry ? catKey : null,
    categoryName: catEntry?.name ?? rawCat,
    subCategoryCode: subName ? subKey : null,
    subCategoryName: subName ?? rawSub,
    colorCode,
    colorName: d.colorName?.trim() || colorNameFor(colorCode, vocab),
  };
}

export function promptDesignFrom(row: DesignRowLike | null | undefined, vocab: VocabLike | null): ResolvedPromptDesign {
  const f = describeDesignFacts(
    { category: row?.category, subCategory: row?.sub_category, color: row?.color, colorName: row?.color_name },
    vocab,
  );
  return {
    title: row?.title,
    category: f.categoryName,
    subCategory: f.subCategoryName,
    categoryCode: f.categoryCode,
    subCategoryCode: f.subCategoryCode,
    color: f.colorCode,
    colorName: f.colorName,
    fabric: row?.fabric,
    handwork: row?.handwork,
    origin: row?.origin,
    tier: row?.tier,
    bgStyle: row?.bg_style,
    bgSeed: `${row?.base_sku ?? ""}|${row?.color ?? ""}`,
  };
}
