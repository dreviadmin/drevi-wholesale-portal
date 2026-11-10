// Shape rules for the codes /admin/lovs accepts. loadVocab() merges LoV
// categories, sub-categories, colours and sizes straight into minting, so a
// code that can't sit inside a SKU must be refused when it is typed — not
// discovered later. Every rule comes from a format the app already enforces:
//
//   · category / sub-category — BASE_SKU_RE (DD-[A-Z]{2,4}-[A-Z0-9]{2,4}-NNN).
//     "BRIDAL" minted DD-BRIDAL-OTH-001, which that regex (and generate_sku's
//     variant mode) then refused, so no size could ever be added to it.
//   · sub-category is scoped "CAT-SUB" — vocab-live.ts skips anything else
//     without a word, so a bare "FLR" saved fine and did nothing.
//   · colour / size — a variant is BASE-SIZE-COLOUR and every parser splits
//     on hyphens (colour = last part), so "RS-GLD" read back as colour GLD.
//
// Fabric and occasion never enter a SKU and stay free-form.

const RULES: Record<string, { re: RegExp; hint: string }> = {
  category: { re: /^[A-Z]{2,4}$/, hint: "A category code is 2–4 letters, e.g. LEH." },
  sub_category: { re: /^[A-Z]{2,4}-[A-Z0-9]{2,4}$/, hint: "A sub-category code is CATEGORY-SUB, e.g. LEH-FLR (2–4 letters, then 2–4 letters or digits)." },
  color: { re: /^[A-Z0-9]+$/, hint: "A colour code is letters and digits only — no hyphens or spaces, e.g. MRN." },
  size: { re: /^[A-Z0-9]+$/, hint: "A size code is letters and digits only — no hyphens or spaces, e.g. XXL." },
};

/** Why `code` (already trimmed + uppercased) can't go on `list`, or null. */
export function lovCodeError(list: string, code: string): string | null {
  const rule = RULES[list];
  if (!rule) return null;
  return rule.re.test(code) ? null : rule.hint;
}
