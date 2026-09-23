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
      // A hung Interakt API sits inside the awaited finalise path — never let
      // it stall an order submit past 8s (audit fix).
      signal: AbortSignal.timeout(8000),
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

/**
 * The buyer's portal login, over WhatsApp (Ansh, 21 Sep).
 *
 * SIXTH template — must be approved in Interakt/Meta before this sends
 * anything; until then sendTemplate logs and skips, which is why the bulk
 * action reports "skipped" rather than claiming success.
 *
 * Body values are POSITIONAL: the approved template's {{1}}..{{4}} must be
 * business, link, login id, password IN THAT ORDER. If the template is
 * approved with a different order, change this array, not the template.
 */
// Bulk credential share from /admin/buyers, and the go-live send (23 Sep).
//
// EVERYTHING ABOUT THE TEMPLATE IS CONFIGURATION, not code. The name, the
// order of the body placeholders and the header media all come from env, so
// the approved template can be whatever Meta let through without a deploy —
// which matters on a day when the template is being approved and the send is
// going out in the same afternoon.
//
//   INTERAKT_CREDENTIALS_TEMPLATE   template name (default wholesale_credentials)
//   INTERAKT_CREDENTIALS_BODY       comma-separated placeholder order, using the
//                                   tokens business | portal | login | password
//                                   (default "business,portal,login,password")
//   INTERAKT_CREDENTIALS_HEADER     URL of the header media — the launch video —
//                                   sent as headerValues[0]. Omit for no header.
//   PORTAL_URL                      what goes in the {{portal}} slot
//
// A placeholder order that does not match the approved template is the one
// failure mode Meta will not catch for you: the message sends, and the buyer
// gets their password where their business name should be. Hence the token
// names — "business,portal,login,password" is checkable against the template
// text by eye.
const CREDENTIAL_TOKENS = ["business", "portal", "login", "password"] as const;
type CredentialToken = (typeof CREDENTIAL_TOKENS)[number];

export function credentialBodyOrder(spec?: string | null): CredentialToken[] {
  const parsed = (spec ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is CredentialToken => (CREDENTIAL_TOKENS as readonly string[]).includes(s));
  return parsed.length ? parsed : [...CREDENTIAL_TOKENS];
}

export async function sendBuyerCredentials(
  phone: string,
  business: string,
  portalUrl: string,
  loginId: string,
  password: string,
): Promise<SendResult> {
  const values: Record<CredentialToken, string> = {
    business,
    portal: portalUrl,
    login: loginId,
    password,
  };
  const order = credentialBodyOrder(process.env.INTERAKT_CREDENTIALS_BODY);
  const header = (process.env.INTERAKT_CREDENTIALS_HEADER ?? "").trim();
  return sendTemplate(
    phone,
    (process.env.INTERAKT_CREDENTIALS_TEMPLATE ?? "").trim() || "wholesale_credentials",
    order.map((k) => values[k]),
    header ? [header] : undefined,
  );
}
