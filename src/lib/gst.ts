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
