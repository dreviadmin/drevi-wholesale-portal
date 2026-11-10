import { describe, it, expect } from "vitest";

import { buyerBillLink, invoiceLink } from "./invoice-link";

const bill = (extra: Partial<{ pdf_url: string | null; cancelled_at: string | null }> = {}) => ({
  id: "0b6f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  pdf_url: "https://storage.test/object/sign/order-pdfs/o1/DX-B1.pdf?token=30-day",
  cancelled_at: null,
  ...extra,
});

describe("invoiceLink", () => {
  it("is the portal's /i/ path for the id", () => {
    expect(invoiceLink("abc")).toBe("/i/abc");
  });
});

describe("buyerBillLink: the PDF link on the buyer's own order page", () => {
  it("is the bill's permanent /i/ link, not the 30-day storage link saved on the row", () => {
    const b = bill();
    expect(buyerBillLink(b)).toBe(`/i/${b.id}`);
    expect(buyerBillLink(b)).not.toContain("storage.test");
  });

  it("is absent for a cancelled bill", () => {
    expect(buyerBillLink(bill({ cancelled_at: "2026-10-03T10:00:00Z" }))).toBeNull();
  });

  it("is absent for a bill whose PDF never stored", () => {
    expect(buyerBillLink(bill({ pdf_url: null }))).toBeNull();
  });

  it("treats a bill with no cancelled_at field as live", () => {
    expect(buyerBillLink({ id: "b2", pdf_url: "x" })).toBe("/i/b2");
  });
});
