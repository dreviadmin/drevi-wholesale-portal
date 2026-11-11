// GST semantics for goods receipts (Ansh, 2 Aug).
//
// Staff enter the price as it appears in the deal; these two functions turn it
// into the numbers the rest of the system uses. Pricing math (auto-MRP /
// auto-wholesale) runs on the EX-GST cost — input credit is claimed on pakka
// bills. The landed cost (with GST) is what actually left the bank.

export interface GstTerms {
  mode: "kaccha" | "pakka" | null;
  rate: number | null; // 5 | 18
  inclusive: boolean | null;
}

/** The cost that feeds pricing. Ex-GST by decision. */
export function exGstCost(entered: number, terms: GstTerms): number {
  if (!entered || entered <= 0) return 0;
  if (terms.mode !== "pakka" || !terms.rate) return entered; // kaccha: as entered
  if (terms.inclusive) return Math.round((entered / (1 + terms.rate / 100)) * 100) / 100;
  return entered; // exclusive: entered is already ex-GST
}

/** What was actually paid per unit, GST and all. */
export function landedCost(entered: number, terms: GstTerms): number {
  if (!entered || entered <= 0) return 0;
  if (terms.mode !== "pakka" || !terms.rate) return entered;
  if (terms.inclusive) return entered;
  return Math.round(entered * (1 + terms.rate / 100) * 100) / 100;
}

/**
 * The bill total the itemised lines imply. With "GST paid on top" the entered
 * costs are ex-GST while the vendor's bill prints the total WITH tax, so the
 * raw comparison flagged every such receipt as differing by the GST itself.
 * Applied to the total rather than per unit (landedCost), so per-unit rounding
 * cannot trip the tolerance.
 */
export function expectedBillTotal(linesValue: number, terms: GstTerms): number {
  if (terms.mode !== "pakka" || !terms.rate || terms.inclusive) return linesValue;
  return linesValue * (1 + terms.rate / 100);
}

/**
 * How far the bill amount is from the itemised total, or null when it is not
 * worth a badge (no bill entered, or within ₹1 — bills round to the rupee).
 * One rule for Log delivery, the receipt editor and the receipt page.
 */
export function billMismatch(bill: number | null | undefined, linesValue: number, terms: GstTerms): number | null {
  if (bill == null || !(bill > 0)) return null;
  const diff = Math.abs(bill - expectedBillTotal(linesValue, terms));
  return diff > 1 ? diff : null;
}
