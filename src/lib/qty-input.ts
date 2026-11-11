// Typed quantities (Oct review): 24 pieces in a buyer's cart took 23 taps on
// +, and 40 pieces of one size on Log delivery took 40. Two readers live here
// because the two fields behave differently on a bad keystroke:
//  · parseQtyInput — buyer cart and product page (components/QtyField). Null
//    for anything that is not a quantity, so the field puts back the last
//    good value. The server still clamps every quantity exactly as before
//    (setQty / addToCart).
//  · parseReceiptQtyInput — Log delivery's size chips and the receipt
//    editor's lines, next to the − / + steppers (components/admin/QtyInput).
//    Always a number, clamped to 1..QTY_MAX.
// Pure, for vitest.

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

/** No delivery line is this big; a stray extra digit stops here. */
export const QTY_MAX = 9999;

/**
 * The delivery or receipt-line quantity a typed value stands for, given the
 * one it replaces.
 *  · empty keeps `prev`, so the field can be cleared and retyped;
 *  · a whole number is clamped to 1..QTY_MAX (0 becomes 1); a decimal drops
 *    its fraction;
 *  · anything else — a minus sign, letters, 1e3 — is 1, never some other
 *    number read out of it.
 */
export function parseReceiptQtyInput(raw: string, prev: number): number {
  const t = raw.trim();
  if (t === "") return prev;
  if (!/^\d+(\.\d+)?$/.test(t)) return 1;
  const n = Math.floor(Number(t));
  return Math.min(QTY_MAX, Math.max(1, n));
}
