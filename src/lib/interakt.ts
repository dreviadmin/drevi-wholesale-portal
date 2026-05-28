import "server-only";

// Interakt WhatsApp + email sends (spec §10). FIVE templates must be approved
// in Interakt/Meta; the payload shapes below follow Interakt's public message
// API and may need field tweaks to match the exact approved templates.
//
// Graceful degradation: when INTERAKT_API_KEY is absent (e.g. before launch),
// every send is a logged no-op — order submission still succeeds and the PDF
// is available via the Download fallback.

const ENDPOINT = "https://api.interakt.ai/v1/public/message/";
const RAKESH_PHONE = "918828043555"; // country code + number, digits only

export type SendResult = { sent: boolean; skipped?: boolean; channel?: string; error?: string };

function splitPhone(phone: string): { countryCode: string; number: string } {
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  // Assume +91 if a 10-digit Indian number; else take leading 2 as country code.
  if (digits.length === 10) return { countryCode: "+91", number: digits };
  if (digits.startsWith("91") && digits.length === 12) return { countryCode: "+91", number: digits.slice(2) };
  return { countryCode: "+" + digits.slice(0, digits.length - 10), number: digits.slice(-10) };
}

async function sendTemplate(
  phone: string,
  templateName: string,
  bodyValues: string[],
  headerValues?: string[],
): Promise<SendResult> {
  const key = process.env.INTERAKT_API_KEY;
  if (!key) {
    console.info(`[interakt] skipped "${templateName}" to ${phone} (no INTERAKT_API_KEY)`);
    return { sent: false, skipped: true, channel: "whatsapp" };
  }
  const { countryCode, number } = splitPhone(phone);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Basic ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        countryCode,
        phoneNumber: number,
        type: "Template",
        template: { name: templateName, languageCode: "en", bodyValues, ...(headerValues ? { headerValues } : {}) },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { sent: false, channel: "whatsapp", error: `${res.status} ${text.slice(0, 200)}` };
    }
    return { sent: true, channel: "whatsapp" };
  } catch (e) {
    return { sent: false, channel: "whatsapp", error: (e as Error).message };
  }
}

// --- To Rakesh ---
export function sendInquiryAlert(business: string, city: string): Promise<SendResult> {
  return sendTemplate(RAKESH_PHONE, "wholesale_inquiry_alert", [business, city]);
}
export function sendPendingReviewAlert(count: number, event: string): Promise<SendResult> {
  return sendTemplate(RAKESH_PHONE, "wholesale_pending_review", [String(count), event]);
}
export function sendOrderAlert(orderNumber: string, business: string, total: string, source: string): Promise<SendResult> {
  return sendTemplate(RAKESH_PHONE, "wholesale_order_alert", [orderNumber, business, total, source]);
}

// --- To buyer ---
export function sendWelcomeEmail(phone: string, business: string): Promise<SendResult> {
  return sendTemplate(phone, "wholesale_welcome_email", [business]);
}
export function sendOrderConfirmation(phone: string, orderNumber: string, total: string, pdfUrl: string): Promise<SendResult> {
  // PDF rides in the template header (document media).
  return sendTemplate(phone, "wholesale_order_confirmation", [orderNumber, total], [pdfUrl]);
}
