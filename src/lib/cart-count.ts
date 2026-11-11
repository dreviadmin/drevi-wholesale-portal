// The buyer's cart badge counts PIECES, on every screen. Home already showed
// pieces (cart.totalQty) while the catalog counted lines and the cart's menu
// counted rows, so one cart read 6 on Home and 2 in the catalog (Oct review).
// Client-safe: the catalog and cart views call it in the browser.

/** Sum of the positive whole quantities; anything else counts as nothing. */
export function cartPieces(qtys: Iterable<number>): number {
  let n = 0;
  for (const q of qtys) {
    if (Number.isFinite(q) && q > 0) n += Math.floor(q);
  }
  return n;
}
