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

// Open the WhatsApp message via the Web Share API where available, else wa.me.
export async function shareWhatsApp(message: string, phone?: string | null): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ text: message });
      return;
    } catch {
      // user cancelled or unsupported — fall through to wa.me
    }
  }
  const digits = waPhone(phone);
  const url = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank", "noopener");
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
