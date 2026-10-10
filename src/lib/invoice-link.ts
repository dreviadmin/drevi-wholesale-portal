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
