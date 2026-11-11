// The colour and size codes a Log delivery mint is about to use, checked
// against the same merged vocabulary /api/sku/generate validates with
// (validCodes() in vocab-live.ts). Pure, so vitest can pin it; the live sets
// are read on the server and passed in.

export interface LiveCodes {
  colors: Set<string>;
  sizes: Set<string>;
}

/**
 * Why these codes can't be minted, or null when they all can. Codes are
 * expected trimmed and upper-cased, as the mint paths already hold them.
 * `color` is optional for a path that has already checked its colour.
 */
export function unknownMintCode(live: LiveCodes, codes: { color?: string; sizes: string[] }): string | null {
  if (codes.color !== undefined && !live.colors.has(codes.color)) return `Unknown colour code "${codes.color}"`;
  const bad = codes.sizes.find((s) => !live.sizes.has(s));
  return bad === undefined ? null : `Unknown size code "${bad}"`;
}
