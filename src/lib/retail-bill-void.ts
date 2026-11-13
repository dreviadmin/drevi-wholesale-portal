// What voiding a retail bill does to stock, in the Void sheet's words. Only a
// catalog line took stock when the bill was saved; a custom line never does,
// so it has none to give back. voidRetailBill uses the same rule, so the sheet
// says what the void will actually do.

export interface BillLineStock {
  custom?: boolean | null;
  sku?: string | null;
}

/** A line that took stock when billed, and so gets it back on a void. */
export const lineTakesStock = (it: BillLineStock): boolean => !it.custom && !!it.sku;

/** The stock sentence of the Void sheet. */
export function voidStockNote(items: readonly BillLineStock[] | null | undefined): string {
  const list = items ?? [];
  const catalog = list.filter(lineTakesStock).length;
  if (list.length === 0) return "No stock comes back.";
  if (catalog === 0) return "Custom items never took stock, so none comes back.";
  if (catalog < list.length) return "Stock for its catalog items comes back to the shelf. Custom items never took stock.";
  return "Stock comes back to the shelf.";
}
