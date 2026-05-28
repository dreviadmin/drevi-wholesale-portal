// Indian-numbering currency formatting, e.g. 182400 -> "₹1,82,400".
export function formatINR(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}
