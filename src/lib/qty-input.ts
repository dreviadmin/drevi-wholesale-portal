// A typed quantity (Oct review): 24 pieces took 23 taps on +. The server still
// clamps every quantity exactly as before (setQty / addToCart); this only
// turns what the buyer typed into a number, or says it isn't one.

/**
 * Whole number from a quantity field, floored to `min`. Null for an empty
 * field or anything that is not just digits ("2a", "-3", "1.5"), so the field
 * can put back the last good value.
 */
export function parseQtyInput(raw: string, min: number): number | null {
  const s = raw.trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  return Math.max(min, parseInt(s, 10));
}
