// The link a buyer gets for an invoice: short, on the portal, and it never
// expires (Ansh, 10 Oct: a buyer's "Invoice PDF" link for DX-20260717-012 had
// died). The storage links it replaces were signed for 30 days (saved on the
// row) or a year (minted by the order page); /i/<id> signs a fresh one each
// time it is opened (src/app/i/[ref]/route.ts). <id> is the order's or the
// bill's id, which only the link's holder knows.
export function invoiceLink(id: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/i/${id}`;
}

// The PDF link the buyer's own order page (src/app/order/[id]/page.tsx) shows
// for one bill. A cancelled bill gets none: cancelBill keeps the row for the
// record and the page shows it struck through, so it must not read as a live
// invoice. A bill whose file never stored (no pdf_url) gets none either, since
// its /i/ link would only say the invoice is not ready.
export function buyerBillLink(bill: { id: string; pdf_url: string | null; cancelled_at?: string | null }): string | null {
  return bill.pdf_url && !bill.cancelled_at ? invoiceLink(bill.id) : null;
}
