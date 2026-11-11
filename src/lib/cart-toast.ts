// What the catalog says once the server has answered a quantity change from a
// card (Nov review). "Added to cart" used to show the moment a size was
// tapped, so a size that had just sold out said "Added to cart" and then
// "This item is no longer available." Now it waits for the reply. Client-safe.

/** Same words as addToCart's refusal; no stock count, buyers aren't shown one. */
export const UNAVAILABLE_MESSAGE = "This item is no longer available.";

/**
 * The toast for a card's change, or null for none.
 * @param before   the line's quantity before the tap (0 = not in the cart)
 * @param asked    the quantity the tap asked for (0 = remove)
 * @param stored   the quantity the server stored (0 = no line)
 */
export function cartReplyToast(before: number, asked: number, stored: number): string | null {
  if (asked <= 0) return null; // "Removed from cart" is said at the tap
  if (stored <= 0) return UNAVAILABLE_MESSAGE;
  return before > 0 ? null : "Added to cart";
}
