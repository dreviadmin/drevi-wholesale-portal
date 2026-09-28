// The vendor who last supplied a design (Ansh, 28 Sep: "show the last vendor
// on the product specs"). Pure, so vitest can pin the order.
//
// Three places can name a vendor, in this order of trust:
//  1. goods receipts — a dated delivery with its vendor. 289 of 302 prod
//     designs have at least one, and 4 were supplied by more than one vendor,
//     so "last" means the latest receipt, not any receipt.
//  2. the sheet's vendor columns on product_vendor_info (sheet-era stock
//     that was never received through the portal).
//  3. designs.vendor_id — set when the design was first logged.

export interface ReceiptVendor {
  receiptId: string;
  receiptNumber: string;
  receiptDate: string | null; // yyyy-mm-dd
  createdAt: string | null;
  vendorId: string;
  vendorName: string | null;
  vendorSku: string | null;
}

export interface SheetVendor {
  vendorName: string | null;
  vendorSku: string | null;
  lastReceiptDate: string | null; // "2026-09-19", "15-Jul-2026" or an Excel serial
}

export interface LastVendor {
  name: string;
  vendorId: string | null;
  date: string | null; // yyyy-mm-dd when known
  receiptId: string | null;
  receiptNumber: string | null;
  vendorSku: string | null;
  source: "receipt" | "sheet" | "design";
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** The sheet wrote dates three ways; normalise to yyyy-mm-dd or null. */
export function normaliseSheetDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
  // Excel serial day (days since 1899-12-30), plausible range only.
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n > 40000 && n < 60000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

export function pickLastVendor(input: {
  receipts: ReceiptVendor[];
  sheet: SheetVendor[];
  design: { vendorId: string | null; vendorName: string | null; vendorSku: string | null } | null;
}): LastVendor | null {
  const named = input.receipts.filter((r) => r.vendorName?.trim());
  if (named.length) {
    const latest = [...named].sort(
      (a, b) =>
        (b.receiptDate ?? "").localeCompare(a.receiptDate ?? "") ||
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        b.receiptNumber.localeCompare(a.receiptNumber),
    )[0];
    // The vendor's own code for the piece: this receipt's line first, then
    // any other line from the SAME vendor, then the design's.
    const sameVendorSku = named.find((r) => r.vendorId === latest.vendorId && r.vendorSku?.trim())?.vendorSku ?? null;
    return {
      name: latest.vendorName!.trim(),
      vendorId: latest.vendorId,
      date: latest.receiptDate,
      receiptId: latest.receiptId,
      receiptNumber: latest.receiptNumber,
      vendorSku: latest.vendorSku?.trim() || sameVendorSku?.trim() || input.design?.vendorSku?.trim() || null,
      source: "receipt",
    };
  }

  const sheet = input.sheet
    .filter((s) => s.vendorName?.trim())
    .map((s) => ({ ...s, date: normaliseSheetDate(s.lastReceiptDate) }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  if (sheet.length) {
    return {
      name: sheet[0].vendorName!.trim(),
      vendorId: null,
      date: sheet[0].date,
      receiptId: null,
      receiptNumber: null,
      vendorSku: sheet[0].vendorSku?.trim() || input.design?.vendorSku?.trim() || null,
      source: "sheet",
    };
  }

  if (input.design?.vendorName?.trim()) {
    return {
      name: input.design.vendorName.trim(),
      vendorId: input.design.vendorId,
      date: null,
      receiptId: null,
      receiptNumber: null,
      vendorSku: input.design.vendorSku?.trim() || null,
      source: "design",
    };
  }
  return null;
}
