// The copy prompt builder (build guide §10 / §8), pure so vitest can load it.
// copy.ts (server-only) re-exports these and does the generation.
//
// Template: docs/reference/copy-template.md when ANSH-02 drops it in; until
// then the guide's built-in minimum — title ≤ 60 chars, 2–3 sentence
// description in brand voice (no exclamation marks, sentences end with
// periods), tags {occasion, fabric, silhouette, color}.

export const BUILT_IN_TEMPLATE = `You write product copy for Drevi, an Indian occasion-wear fashion house (lehengas, sarees, sharara sets, gowns). Voice: refined, confident, tactile — never salesy. No exclamation marks. Sentences end with periods.

From the photos and the facts below, return STRICT JSON only (no markdown fence):
{"title": "<= 60 characters, Title Case, no SKU>",
 "description": "2-3 sentences: silhouette, fabric/handwork, occasion. Specific to what is visible.",
 "tags": {"occasion": "...", "fabric": "...", "silhouette": "...", "color": "..."}}`;

export interface PromptFacts {
  title?: string | null; category?: string | null; subCategory?: string | null;
  /** Vocab codes when category/subCategory resolved to names (facts.ts); null otherwise. */
  categoryCode?: string | null; subCategoryCode?: string | null;
  color?: string | null; colorName?: string | null; fabric?: string | null; handwork?: string | null;
  origin?: string | null; tier?: string | null;
}

/** §8 — the prompt an unedited design would run, built from its own specs. */
export function defaultCopyPrompt(d: PromptFacts): string {
  const catCodes = [d.categoryCode, d.subCategoryCode].filter(Boolean).join("-");
  const catLabel = [d.category, d.subCategory].filter(Boolean).join(" / ");
  const facts = [
    d.title && `Working name: ${d.title}`,
    d.category && `Category: ${catLabel}${catCodes && catCodes !== catLabel ? ` (code ${catCodes})` : ""}`,
    d.colorName ? `Colour: ${d.colorName} (code ${d.color ?? "?"})` : d.color && `Colour code: ${d.color}`,
    d.fabric && `Fabric (verified): ${d.fabric}`,
    d.handwork && `Handwork (verified): ${d.handwork}`,
    d.origin && `Origin: ${d.origin}`,
    d.tier && `Tier: ${d.tier}`,
  ].filter(Boolean).join("\n");
  return `${BUILT_IN_TEMPLATE}\n\nFACTS:\n${facts}`;
}
