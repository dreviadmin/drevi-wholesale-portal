import "server-only";

import { formatPaise } from "@/lib/wallet-core";

// WhatsApp sends for the wallet, through AiSensy's Campaign API — the same
// AiSensy the storefront already uses, so the customer hears from one number.
// Three campaigns, each bound in the AiSensy dashboard to a Meta-approved
// template (drafts in docs/wallet-aisensy-templates.md):
//
//   AISENSY_CAMPAIGN_OTP      Authentication template, {{1}} = the code
//   AISENSY_CAMPAIGN_WELCOME  Marketing template: name, amount
//   AISENSY_CAMPAIGN_BALANCE  Utility template: name, balance, expiry
//
// AiSensy creates the contact if the number isn't on the list yet, which is
// the whole reason the popup exists — so a welcome send also puts them on
// the WhatsApp list.
//
// Nothing goes out unless WALLET_WA_LIVE=true. Everywhere else the send is a
// logged dry run, so a local test can never message a real customer.

const ENDPOINT = "https://backend.aisensy.com/campaign/t1/api/v2";

export type WaResult = { sent: boolean; skipped?: boolean; dryRun?: boolean; error?: string };

function live(): boolean {
  return (process.env.WALLET_WA_LIVE ?? "").toLowerCase() === "true";
}

/**
 * Meta's component format for a template button that takes a parameter —
 * the copy-code button on an Authentication template. AiSensy passes it
 * through. Without it Meta rejects the send with "Required parameter is
 * missing" (seen on the first live test): an OTP template needs the code
 * twice, once for the body and once for the button.
 */
type ButtonParam = { type: "button"; sub_type: "url"; index: number; parameters: Array<{ type: "text"; text: string }> };
const copyCodeButton = (code: string): ButtonParam[] => [{ type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: code }] }];

async function send(campaignEnv: string, fallbackName: string, phone: string, userName: string, params: string[], tags: string[] = [], buttons?: ButtonParam[]): Promise<WaResult> {
  const campaignName = process.env[campaignEnv] || fallbackName;
  const apiKey = process.env.AISENSY_API_KEY;
  if (!live()) {
    console.info(`[wallet-wa] DRY RUN ${campaignName} -> +${phone} params=${JSON.stringify(params)}`);
    return { sent: false, dryRun: true };
  }
  if (!apiKey) {
    console.error(`[wallet-wa] NOT SENT ${campaignName} -> +${phone}: AISENSY_API_KEY is not set in this deployment`);
    return { sent: false, skipped: true, error: "no_api_key" };
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        campaignName,
        destination: "+" + phone,
        userName: userName || "Customer",
        source: "drevi-wallet",
        templateParams: params,
        tags: ["wallet", ...tags],
        ...(buttons ? { buttons } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text().catch(() => "");
    // AiSensy answers 200 with {"success":"true"} — and, for a bad campaign
    // name or destination, sometimes 200 with an error body. Read the body.
    if (!res.ok || !/"success"\s*:\s*"?true"?/.test(text)) {
      console.error(`[wallet-wa] NOT SENT ${campaignName} -> +${phone}: HTTP ${res.status} ${text.slice(0, 300)}`);
      return { sent: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[wallet-wa] NOT SENT ${campaignName} -> +${phone}: ${(e as Error).message}`);
    return { sent: false, error: (e as Error).message };
  }
}

export function sendWalletOtp(phone: string, code: string): Promise<WaResult> {
  return send("AISENSY_CAMPAIGN_OTP", "drevi_wallet_otp", phone, "Customer", [code], [], copyCodeButton(code));
}

export function sendWalletWelcome(phone: string, name: string | null, balancePaise: number): Promise<WaResult> {
  return send("AISENSY_CAMPAIGN_WELCOME", "drevi_wallet_welcome", phone, name ?? "there", [name ?? "there", formatPaise(balancePaise)], ["welcome"]);
}

export function sendWalletBalance(phone: string, name: string | null, balancePaise: number, expiresAt: string | null): Promise<WaResult> {
  const exp = expiresAt ? new Date(expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
  return send("AISENSY_CAMPAIGN_BALANCE", "drevi_wallet_balance", phone, name ?? "there", [name ?? "there", formatPaise(balancePaise), exp]);
}
