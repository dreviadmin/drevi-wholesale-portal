import "server-only";

import { waPhone } from "@/lib/share";
import { portalOrigin } from "@/lib/login-link-core";

// WhatsApp template sends for the wholesale portal through AiSensy's Campaign
// API, from the wholesale number (+91 86553 55958). Each send names a Live
// "API campaign" in the AiSensy dashboard, bound there to one Meta-approved
// template. Two templates, neither carrying a password (Meta rejects those);
// each has a URL button https://<portal>/go/{{1}} whose value is the buyer's
// one-tap login token (0073):
//
//   AISENSY_CAMPAIGN_LOGIN     Utility — walkthrough video, {{1}} = shop name.
//                              The guaranteed copy; also what "Send login on
//                              WhatsApp" in admin sends to new buyers.
//   AISENSY_CAMPAIGN_GREETING  Marketing — Rakesh's greeting video, no body
//                              variables. Launch only (scripts/send-launch.mjs).
//
// AISENSY_LINK_ORIGIN is the https origin the approved buttons open. The token
// only works on the site whose database minted it, so every sender checks that
// origin answers for its token before sending (preflightLoginLink).
//
// Header videos: AISENSY_LOGIN_VIDEO_URL / AISENSY_GREETING_VIDEO_URL, public
// URLs AiSensy fetches. The URL button's position in the template:
// AISENSY_URL_BUTTON_INDEX (default 0 — put the link button first).

const ENDPOINT = "https://backend.aisensy.com/campaign/t1/api/v2";

/**
 * `uncertain`: the request may have reached AiSensy (timeout, dropped
 * connection, 5xx) — never retry it blindly, the buyer may already have it.
 */
export type WaSend = { sent: boolean; skipped?: boolean; uncertain?: boolean; error?: string };

export type LaunchMessage = "login" | "greeting";

const CONFIG: Record<LaunchMessage, { campaign: string; video: string; params: (business: string) => string[] }> = {
  login: { campaign: "AISENSY_CAMPAIGN_LOGIN", video: "AISENSY_LOGIN_VIDEO_URL", params: (b) => [b] },
  greeting: { campaign: "AISENSY_CAMPAIGN_GREETING", video: "AISENSY_GREETING_VIDEO_URL", params: () => [] },
};

/**
 * "+<cc><number>" or null. AiSensy resolves an unrecognisable destination to
 * India by default rather than failing, so anything that is not plainly a
 * mobile number is refused: an Indian number must be 91 + a 6-9 mobile prefix
 * + 9 digits (a landline like 022… fails). A foreign number only counts when
 * it was written with a leading + or 00 — otherwise a mistyped Indian mobile
 * (one digit short or long) would go abroad carrying a live login.
 */
export function e164(phone: string | null | undefined): string | null {
  const raw = (phone ?? "").trim();
  const digits = waPhone(raw);
  if (digits.startsWith("91")) return /^91[6-9]\d{9}$/.test(digits) ? `+${digits}` : null;
  if (!/^(\+|00)/.test(raw)) return null;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export function linkOrigin(): string | null {
  const v = process.env.AISENSY_LINK_ORIGIN?.trim();
  if (!v) return null;
  try {
    return portalOrigin(v);
  } catch {
    return null;
  }
}

/** Every env var the send needs, by name — empty when ready. */
export function launchMissing(kind: LaunchMessage): string[] {
  const c = CONFIG[kind];
  return ["AISENSY_API_KEY", c.campaign, c.video, "AISENSY_LINK_ORIGIN"].filter((k) =>
    k === "AISENSY_LINK_ORIGIN" ? !linkOrigin() : !process.env[k]?.trim(),
  );
}

export function launchConfigured(kind: LaunchMessage): boolean {
  return launchMissing(kind).length === 0;
}

export interface LaunchPayload {
  apiKey: string;
  campaignName: string;
  destination: string;
  userName: string;
  source: string;
  templateParams: string[];
  media: { url: string; filename: string };
  buttons: Array<{ type: "button"; sub_type: "url"; index: number; parameters: Array<{ type: "text"; text: string }> }>;
  tags: string[];
}

/** The request body, exposed so the launch script can show it in a dry run. */
export function launchPayload(kind: LaunchMessage, destination: string, business: string, token: string): LaunchPayload {
  const c = CONFIG[kind];
  const video = process.env[c.video]!.trim();
  const index = Number.parseInt(process.env.AISENSY_URL_BUTTON_INDEX ?? "0", 10) || 0;
  return {
    apiKey: process.env.AISENSY_API_KEY!.trim(),
    campaignName: process.env[c.campaign]!.trim(),
    destination,
    userName: business,
    source: "drevi-wholesale-portal",
    templateParams: c.params(business),
    media: { url: video, filename: video.split("/").pop()?.split("?")[0] || "video.mp4" },
    // Meta's component for a URL button with a variable suffix: the token is
    // the {{1}} in https://<portal>/go/{{1}}. Same shape the wallet's
    // copy-code button used through this endpoint.
    buttons: [{ type: "button", sub_type: "url", index, parameters: [{ type: "text", text: token }] }],
    tags: ["wholesale", `wholesale-${kind}`],
  };
}

/**
 * Does the site the buttons open recognise this token? Fetches /go/<token>
 * the way a buyer's phone would, minus the tap: the page only signs in on its
 * form POST, so a GET changes nothing. A token minted in another database
 * (dev vs prod) renders "doesn't work any more" instead of the open prompt.
 */
export async function preflightLoginLink(token: string): Promise<{ ok: boolean; error?: string }> {
  const origin = linkOrigin();
  if (!origin) return { ok: false, error: "AISENSY_LINK_ORIGIN is not set" };
  try {
    const res = await fetch(`${origin}/go/${token}`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10000) });
    const html = await res.text().catch(() => "");
    if (res.status === 200 && html.includes("Opening the account for")) return { ok: true };
    return { ok: false, error: `${origin} does not recognise this site's login links (HTTP ${res.status}) — check AISENSY_LINK_ORIGIN` };
  } catch (e) {
    return { ok: false, error: `could not reach ${origin}: ${(e as Error).message}` };
  }
}

/**
 * Send one launch message. `skipped` = not configured on this deployment (a
 * logged no-op, never reported as sent). AiSensy answers 200 with
 * {"success":"true"} on success and sometimes 200 with an error body, so the
 * body decides — not the status code.
 */
export async function sendLaunchMessage(
  kind: LaunchMessage,
  phone: string | null,
  business: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<WaSend> {
  const missing = launchMissing(kind);
  if (missing.length) {
    console.info(`[aisensy] NOT CONFIGURED ${kind} — missing ${missing.join(", ")}`);
    return { sent: false, skipped: true };
  }
  const destination = e164(phone);
  if (!destination) return { sent: false, error: "not a WhatsApp mobile number" };
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(launchPayload(kind, destination, business, token)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (e) {
    // Timeout or dropped connection: the request may have been accepted.
    return { sent: false, uncertain: true, error: (e as Error).message };
  }
  const text = await res.text().catch(() => "");
  if (res.ok && /"success"\s*:\s*"?true"?/.test(text)) return { sent: true };
  return { sent: false, uncertain: res.status >= 500, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
}
