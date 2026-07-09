// Indian-numbering currency formatting, e.g. 182400 -> "₹1,82,400".
export function formatINR(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

// Like formatINR but keeps paise when the value isn't a whole rupee — used for
// per-unit prices under a GST split (e.g. 4995/4 = ₹1,248.75) so the line's
// qty × unit reconciles with the line total instead of rounding to ₹1,249.
export function formatUnitINR(amount: number): string {
  const isWhole = Math.abs(amount - Math.round(amount)) < 0.005;
  return isWhole
    ? formatINR(amount)
    : `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
