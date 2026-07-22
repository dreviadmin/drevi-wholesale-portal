// Pure builders for the WhatsApp credential message (spec §6.5) and the vCard
// (spec §7.6). Called from client handlers that invoke the Web Share API / wa.me
// or trigger a .vcf download.

const PORTAL_URL = "wholesale.drevifashion.com";
const RAKESH_PHONE = "+91 88280 43555";

export function buildWhatsAppMessage(email: string, password: string): string {
  return [
    "Welcome to Drevi Wholesale Portal",
    "",
    `Link: ${PORTAL_URL}`,
    `Email: ${email}`,
    `Password: ${password}`,
    "",
    "Save this message. Tap the link anytime to",
    "browse our full catalog with wholesale pricing.",
    "",
    "- Rakesh",
    RAKESH_PHONE,
  ].join("\n");
}

export interface VCardInput {
  ownerName: string | null;
  businessName: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  status: string;
  onboarded: string | null; // ISO
}

export function buildVCard(b: VCardInput): string {
  const fn = `${b.ownerName ?? b.businessName ?? "Drevi Buyer"}${b.businessName ? ` (${b.businessName})` : ""}`;
  const tel = (b.phone ?? "").replace(/[^\d+]/g, "");
  const onboarded = b.onboarded
    ? new Date(b.onboarded).toLocaleDateString("en-IN", { month: "short", year: "numeric" })
    : "";
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${fn}`,
    b.businessName ? `ORG:${b.businessName}` : "",
    "TITLE:Owner",
    tel ? `TEL;TYPE=CELL:${tel}` : "",
    b.email ? `EMAIL:${b.email}` : "",
    b.city ? `ADR;TYPE=WORK:;;${b.city};;;India` : "",
    `NOTE:Drevi Wholesale · ${b.status}${onboarded ? ` · Onboarded ${onboarded}` : ""}`,
    "END:VCARD",
  ].filter(Boolean);
  return lines.join("\n");
}

// wa.me requires FULL international format — a bare 10-digit Indian number
// (what the public inquiry form stores) makes WhatsApp reject the link.
// Mirrors interakt.splitPhone: strip leading zeros, prefix 91 on 10 digits.
export function waPhone(phone?: string | null): string {
  let digits = (phone ?? "").replace(/[^\d]/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

// Open WhatsApp. With a phone number we go STRAIGHT to that customer's chat
// (wa.me/<phone>) — the generic share sheet made staff pick the recipient by
// hand every time. Without a phone, fall back to the share sheet / picker.
export async function shareWhatsApp(message: string, phone?: string | null): Promise<void> {
  const digits = waPhone(phone);
  if (digits) {
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
    return;
  }
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ text: message });
      return;
    } catch {
      // user cancelled or unsupported — fall through to wa.me picker
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener");
}

// Share the ACTUAL PDF file (not a link — buyers distrust bare links) with a
// clean, recognisable filename. Uses the Web Share API with file support
// (Android Chrome, iOS 15+); the caller decides the fallback when the device
// can't share files.
export async function sharePdfFile(opts: { url: string; filename: string; text?: string }): Promise<"shared" | "cancelled" | "unsupported" | "failed"> {
  try {
    const res = await fetch(opts.url);
    if (!res.ok) return "failed";
    const blob = await res.blob();
    const file = new File([blob], opts.filename, { type: "application/pdf" });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (!nav.share || !nav.canShare?.({ files: [file] })) return "unsupported";
    try {
      await nav.share({ files: [file], title: opts.filename, ...(opts.text ? { text: opts.text } : {}) });
      return "shared";
    } catch (e) {
      return (e as Error).name === "AbortError" ? "cancelled" : "failed";
    }
  } catch {
    return "failed";
  }
}

// House style for shared invoice files: obviously from Drevi, obviously which
// order — suspicious-looking generic names get PDFs ignored.
export function invoiceFileName(orderNumber: string, isInvoice = true): string {
  const safe = orderNumber.replace(/[^A-Za-z0-9-]/g, "");
  return `Drevi-${isInvoice ? "Invoice" : "Order"}-${safe}.pdf`;
}

export function downloadVCard(vcard: string, filename: string): void {
  const blob = new Blob([vcard], { type: "text/vcard;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
