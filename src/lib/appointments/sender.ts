import "server-only";

import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTemplateMessage } from "@/lib/aisensy";
import { orderTagBlocker } from "@/lib/wallet-core";
import { loadConfig, APPT_COLS } from "./server";
import { TEMPLATES, dayShort, fromIst, hm, isLive, istParts, renderParams, templateFor, wentToTest, type Appt, type Config, type RenderCtx } from "./core";

// The appointment message sender. It runs:
//   - every 5 minutes, called by the database (pg_cron, 0113) with the token
//     in appointment_sender, and every few hours by GitHub (the backstop);
//   - straight after a booking is made or changed, for that booking only
//     (sendDueNow in ./kick.ts), so a confirmation never waits for the clock;
//   - when staff tap Send on a booking (sendManual).
//
// Order of safety checks for every due row (each one ends the row as "skipped"
// with its reason, never "sent"):
//   1. automatic messages switched off in Settings: nothing is claimed at all;
//      rows past their expiry are marked "Too late to send" by the claim, so
//      turning the switch on later never floods anyone with old alerts.
//   2. not production (a dev deploy, or production code pointed at the dev
//      database): only numbers on the test list are ever messaged.
//   3. test mode: every message goes to the test numbers instead of the person.
//   4. no AiSensy key for the customer number. Each AiSensy API campaign is
//      named after its template (Settings can name a different one).
//   5. the booking is no longer live (for reminders), or the customer said no
//      to WhatsApp.
//   6. a moved or cancelled note that is no longer true (Undo, a later cancel),
//      or a customer message whose number has since been corrected.
// A send that times out is "uncertain" and is never retried automatically.
// A tap on Send passes checks 2 to 4 (the switch is for automatic sending only).

type Row = { id: string; appointment_id: string | null; rule: string; template: string; audience: string; recipient_name: string | null; to_address: string; params: Record<string, unknown> | null; due_at: string };
type MsgRow = Row & { state: string; created_at: string; sent_at: string | null };
const REMINDER_RULES = new Set(["c-confirm", "c-24h", "c-2h", "s-heads-up", "s-pending"]);

export interface SenderResult { automation: boolean; testMode: boolean; claimed: number; sent: number; failed: number; uncertain: number; skipped: number; digests: number; note?: string }

/** The AiSensy project for +91 84336 59684: its own key if set, else the portal's existing AiSensy key (same project). */
const apiKey = () => process.env.AISENSY_APPT_API_KEY?.trim() || process.env.AISENSY_API_KEY?.trim() || "";
const isProd = () => orderTagBlocker({ VERCEL_ENV: process.env.VERCEL_ENV, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL }) === null;

/** Where a message to `to` really goes, or why it cannot go (checks 2 to 4 above). */
function routeFor(cfg: Config, tplName: string, to: string): { to: string; campaign: string; test: boolean } | { skip: string } | { fail: string } {
  if (!apiKey()) return { skip: "No AiSensy key is set (AISENSY_APPT_API_KEY or AISENSY_API_KEY)" };
  if (!TEMPLATES[tplName]) return { fail: `unknown template ${tplName}` };
  const set = cfg.settings, tests = set.test_numbers ?? [];
  let dest = to;
  if (set.test_mode) { if (!tests.length) return { skip: "Test mode is on and there is no test number" }; dest = tests[0]; }
  if (!isProd() && !tests.includes(dest)) return { skip: "Not production: only test numbers are messaged" };
  return { to: dest, campaign: set.campaigns?.[tplName]?.trim() || tplName, test: set.test_mode };
}

type Outcome = { state: "sent" | "failed" | "uncertain" | "skipped"; to: string; test: boolean; reason?: string | null; error?: string };
async function deliver(cfg: Config, tplName: string, to: string, recipientName: string, audience: string, a: Appt | null, ctx: Omit<RenderCtx, "types">): Promise<Outcome> {
  const r = routeFor(cfg, tplName, to);
  if ("skip" in r) return { state: "skipped", to, test: false, reason: r.skip };
  if ("fail" in r) return { state: "failed", to, test: false, error: r.fail };
  let params: string[];
  try { params = renderParams(tplName, a, { types: cfg.types, ...ctx }); }
  catch (e) { return { state: "failed", to: r.to, test: r.test, error: (e as Error).message }; }
  const res = await sendTemplateMessage({ apiKey: apiKey(), campaignName: r.campaign, destination: r.to, userName: recipientName || "Customer", params, tags: ["appointments", audience] });
  if (res.sent) return { state: "sent", to: r.to, test: r.test, reason: r.test ? `Test mode: sent to ${r.to}` : null };
  return { state: res.uncertain ? "uncertain" : "failed", to: r.to, test: r.test, error: res.error ?? "unknown" };
}

export async function runAppointmentSender(now = new Date(), opts: { appointmentId?: string } = {}): Promise<SenderResult> {
  const admin = createAdminClient();
  const c = await loadConfig();
  if (!c.ok) return { automation: false, testMode: true, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0, digests: 0, note: c.missing ? "not set up" : c.error };
  const cfg = c.data, set = cfg.settings;
  const out: SenderResult = { automation: set.automation_on, testMode: set.test_mode, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0, digests: 0 };
  await ensureSenderUrl();

  if (!set.automation_on) {
    if (!opts.appointmentId) await admin.rpc("appt_claim_messages", { p_limit: 0 }); // only expires stale rows
    out.note = "automatic messages are off";
    return out;
  }
  if (!opts.appointmentId) out.digests = await queueDailyList(cfg, now);

  // One booking's due rows (straight after it was made or changed), or everything that is due.
  // (Before 0113 there is no per-booking claim: then the scheduled run sends them instead.)
  const claim = opts.appointmentId
    ? await admin.rpc("appt_claim_messages_for", { p_appointment: opts.appointmentId, p_limit: 30 })
    : await admin.rpc("appt_claim_messages", { p_limit: 30 });
  if (claim.error) { out.note = claim.error.message; return out; }
  const rows = (claim.data ?? []) as Row[];
  out.claimed = rows.length;
  if (!rows.length) return out;

  const ids = [...new Set(rows.map((r) => r.appointment_id).filter(Boolean))] as string[];
  const appts = new Map<string, Appt>();
  if (ids.length) {
    const { data, error: readErr } = await admin.from("appointments").select(APPT_COLS).in("id", ids);
    if (readErr) {
      // Could not read the bookings: put the rows back as they were rather than judge them on nothing.
      await admin.from("appointment_messages").update({ state: "scheduled", updated_at: new Date().toISOString() }).in("id", rows.map((r) => r.id));
      out.note = readErr.message; out.claimed = 0; return out;
    }
    for (const a of (data ?? []) as Appt[]) appts.set(a.id, a);
  }

  const finish = async (r: Row, state: string, patch: Record<string, unknown> = {}) => {
    await admin.from("appointment_messages").update({ state, updated_at: new Date().toISOString(), ...patch }).eq("id", r.id);
    if (state === "sent") out.sent++; else if (state === "failed") out.failed++; else if (state === "uncertain") out.uncertain++; else out.skipped++;
  };

  const work = rows.map((r) => async () => {
    const a = r.appointment_id ? appts.get(r.appointment_id) ?? null : null;
    if (r.appointment_id && !a) return finish(r, "skipped", { reason: "The booking is gone" });
    if (a && REMINDER_RULES.has(r.rule) && !isLive(a.status)) return finish(r, "skipped", { reason: "The booking is no longer live" });
    if (a && r.audience === "client" && !a.notify_wa) return finish(r, "skipped", { reason: "The customer said no to WhatsApp" });
    // A moved/cancelled note waiting in the queue must still be true when it goes.
    const evKind = r.rule === "ev-cancelled" ? "cancelled" : r.rule === "ev-moved" ? "moved" : r.rule === "ev-staff" ? String(r.params?.kind ?? "") : "";
    if (a && evKind === "cancelled" && a.status !== "cancelled") return finish(r, "skipped", { reason: "The booking was reopened" });
    if (a && evKind === "moved" && !isLive(a.status)) return finish(r, "skipped", { reason: "The booking is no longer live" });
    if (a && r.audience === "client" && r.to_address !== a.phone_e164) return finish(r, "skipped", { reason: "The WhatsApp number on the booking changed" });
    // The customer's wording follows where the booking happens now (store or a call), whatever was planned.
    const tplName = (a && templateFor(r.rule, a)) || r.template;
    const o = await deliver(cfg, tplName, r.to_address, r.recipient_name || "Customer", r.audience, a, contextFor(r, a));
    if (o.state === "sent") return finish(r, "sent", { sent_at: new Date().toISOString(), last_error: null, reason: o.reason ?? null });
    if (o.state === "skipped") return finish(r, "skipped", { reason: o.reason ?? null });
    return finish(r, o.state, { last_error: o.error ?? "unknown" });
  });
  // Six at a time, so 30 rows at an 8 s timeout stay inside the 60 s function limit.
  for (let i = 0; i < work.length; i += 6) await Promise.all(work.slice(i, i + 6).map((f) => f().catch(() => undefined)));
  return out;
}

function contextFor(r: Pick<Row, "rule" | "params">, a: Appt | null): Omit<RenderCtx, "types"> {
  if (r.rule === "s-digest") return { digest: r.params?.digest as { count: number; list: string } };
  if (!a) return {};
  if (r.rule === "ev-staff") {
    const p = istParts(a.starts_at);
    return { change: r.params?.kind === "cancelled" ? "cancelled" : `moved to ${dayShort(p.day)} at ${hm(p.min)}`, byName: String(r.params?.by ?? "staff") };
  }
  if (r.rule === "ev-cancelled") return { reason: a.cancel_reason === "Shop closed" ? "The shop is closed then. We are sorry for the trouble." : "We are sorry for any trouble." };
  return {};
}

/** One daily list per person per day, in the hour after digest_hour (IST). */
async function queueDailyList(cfg: Config, now: Date): Promise<number> {
  const { day, min } = istParts(now);
  if (min < cfg.settings.digest_hour * 60 || min >= (cfg.settings.digest_hour + 2) * 60) return 0;
  const people = cfg.people.filter((p) => p.active && p.on_digest && p.wa_e164);
  if (!people.length) return 0;
  const admin = createAdminClient();
  const { data } = await admin.from("appointments").select("starts_at, customer_name, type_id, status").gte("starts_at", fromIst(day, 0).toISOString()).lt("starts_at", fromIst(day, 1440).toISOString()).in("status", ["requested", "confirmed"]).order("starts_at");
  const list = (data ?? []) as Array<{ starts_at: string; customer_name: string; type_id: string; status: string }>;
  if (!list.length) return 0;
  const short = (id: string) => cfg.types.find((t) => t.id === id)?.short_name.toLowerCase() ?? "appointment";
  const digest = { count: list.length, list: list.map((x) => `${hm(istParts(x.starts_at).min)} ${short(x.type_id)} (${x.customer_name.split(/\s+/)[0]}${x.status === "requested" ? ", not confirmed" : ""})`).join(", ") };
  const rows = people.map((p) => ({ appointment_id: null, dedupe_key: `digest:${day}:${p.wa_e164}`, rule: "s-digest", template: "drevi_staff_today", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, params: { digest }, due_at: now.toISOString(), expires_at: new Date(now.getTime() + 3 * 3600000).toISOString(), state: "scheduled" }));
  const { data: ins } = await admin.from("appointment_messages").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
  return (ins ?? []).length;
}

/* ---------------- Send, tapped on a booking ---------------- */

export type ManualResult = { ok: true; to: string; test: boolean } | { ok: false; error: string; again?: boolean };
const CLAIMABLE = ["scheduled", "skipped", "failed", "cancelled"];
const H6 = 6 * 3600000;

/**
 * Sends one customer template now. Outside test mode it goes through the
 * message row it belongs to: the waiting one if there is one (so the automatic
 * send does not repeat it), else a new row; if the send does not go, the row is
 * put back as it was, so the automatic send still happens. It refuses while
 * another send of it is in flight, and asks for `again` when the last one
 * already reached the customer. In test mode it always makes its own row and
 * leaves the customer's messages alone.
 */
export async function sendManual(o: { cfg: Config; appt: Appt; rule: string; byName: string; again: boolean }): Promise<ManualResult> {
  const { cfg, appt: a, rule } = o;
  const admin = createAdminClient();
  const tplName = templateFor(rule, a);
  if (!tplName) return { ok: false, error: "There is no WhatsApp message for that." };
  const route = routeFor(cfg, tplName, a.phone_e164);
  if ("skip" in route) return { ok: false, error: `Not sent: ${route.skip}.` };
  if ("fail" in route) return { ok: false, error: `Not sent: ${route.fail}.` };

  const { data: existing, error: readErr } = await admin.from("appointment_messages").select("id, rule, template, audience, recipient_name, to_address, params, due_at, state, reason, created_at, sent_at, appointment_id")
    .eq("appointment_id", a.id).eq("rule", rule).order("created_at", { ascending: false }).limit(20);
  if (readErr) return { ok: false, error: readErr.message };
  const rows = ((existing ?? []) as Array<MsgRow & { reason: string | null }>).filter((r) => r.audience === "client");
  if (rows.some((r) => r.state === "sending")) return { ok: false, error: "It is being sent right now. Reload the page in a minute to see whether it went." };
  const test = route.test;
  const target = test ? null : rows.find((r) => r.state === "scheduled") ?? (rows[0] && CLAIMABLE.includes(rows[0].state) ? rows[0] : null);
  const reached = rows.find((r) => (r.state === "sent" && !wentToTest(r)) || r.state === "uncertain");
  if (!test && reached && !o.again && target?.state !== "scheduled") {
    return { ok: false, again: true, error: reached.state === "sent" ? "It has already been sent. Reload the page, then send it again if you need to." : "The last try may or may not have gone. Reload the page and check the chat first." };
  }

  const now = new Date(), nowIso = now.toISOString();
  let rowId: string, before: string | null = null;
  if (target) {
    const { data: got, error } = await admin.from("appointment_messages").update({ state: "sending", updated_at: nowIso })
      .eq("id", target.id).eq("state", target.state).select("id"); // any change since the read (a move, another tap) stops it
    if (error) return { ok: false, error: error.message };
    if (!got?.length) return { ok: false, error: "Someone else is sending it right now. Reload the page." };
    rowId = target.id; before = target.state;
  } else {
    // Keyed to the minute: two taps on two phones at once make one row, not two sends.
    // The same expiry the planner gives it, so a failed one cannot be sent again days late from Messages.
    const expires = rule === "ev-cancelled" ? new Date(now.getTime() + H6).toISOString() : rule === "c-2h" ? new Date(new Date(a.starts_at).getTime() - 15 * 60000).toISOString() : a.starts_at;
    const { data: ins, error } = await admin.from("appointment_messages").insert({
      appointment_id: a.id, dedupe_key: `${a.id}:manual:${rule}:${nowIso.slice(0, 16)}`, rule, template: tplName, channel: "wa", audience: "client",
      recipient_name: a.customer_name, to_address: a.phone_e164, params: {}, due_at: nowIso, expires_at: expires, state: "sending", attempts: 1,
    }).select("id").single();
    if (error && (error as { code?: string }).code === "23505") return { ok: false, error: "It was sent a moment ago. Reload the page; to send it again, wait a minute." };
    if (error || !ins) return { ok: false, error: error?.message ?? "Could not note the message." };
    rowId = (ins as { id: string }).id;
  }

  const out = await deliver(cfg, tplName, a.phone_e164, a.customer_name, "client", a, contextFor({ rule, params: null }, a));
  const at = new Date().toISOString();
  if (out.state === "sent") {
    await admin.from("appointment_messages").update({ state: "sent", sent_at: at, reason: `Sent by ${o.byName}${out.test ? ` (test mode: to ${out.to})` : ""}`, last_error: null, to_address: a.phone_e164, updated_at: at }).eq("id", rowId);
    // Anything else of this kind still waiting would say the same thing again.
    if (!out.test) await admin.from("appointment_messages").update({ state: "cancelled", reason: `Sent by ${o.byName} instead`, updated_at: at })
      .eq("appointment_id", a.id).eq("rule", rule).eq("audience", "client").eq("state", "scheduled");
    return { ok: true, to: out.to, test: out.test };
  }
  if (out.state === "uncertain") {
    await admin.from("appointment_messages").update({ state: "uncertain", last_error: out.error ?? "unknown", reason: `Tapped by ${o.byName}`, updated_at: at }).eq("id", rowId);
    return { ok: false, error: "AiSensy did not answer, so it may or may not have gone. Check the chat on the shop phone before sending it again." };
  }
  // It did not go: a waiting row goes back to waiting (the automatic send still happens), a new row is kept as failed.
  await admin.from("appointment_messages").update(before
    ? { state: before, last_error: out.error ?? out.reason ?? "unknown", updated_at: at }
    : { state: out.state, last_error: out.error ?? null, reason: out.state === "skipped" ? out.reason ?? null : `Tapped by ${o.byName}`, updated_at: at }).eq("id", rowId);
  if (out.state === "skipped") return { ok: false, error: `Not sent: ${out.reason}.` };
  return { ok: false, error: `WhatsApp did not send it: ${out.error}. Try again in a minute; if it keeps failing, check the AiSensy campaign ${route.campaign}.` };
}

/* ---------------- the 5-minute schedule (0113) ---------------- */

/** The production address of this deployment, for the database's 5-minute call. Null on previews and locally. */
function ownOrigin(): string | null {
  if (process.env.VERCEL_ENV !== "production") return null;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return host && /^[A-Za-z0-9.-]+$/.test(host) ? `https://${host}` : null;
}
let checkedAt = 0;
/** Tells the database where to call (looked at every 10 minutes per server instance; nothing if 0113 is not applied). */
export async function ensureSenderUrl(): Promise<void> {
  const url = ownOrigin();
  if (!url || Date.now() - checkedAt < 10 * 60000) return;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from("appointment_sender").select("url").eq("id", 1).maybeSingle();
    if (error || !data) return;
    if ((data as { url: string | null }).url !== url) {
      const { error: upErr } = await admin.from("appointment_sender").update({ url, updated_at: new Date().toISOString() }).eq("id", 1);
      if (upErr) return;
    }
    checkedAt = Date.now();
  } catch { /* the next run tries again */ }
}

/** Whether a call to the cron route carries the database's token. False when 0113 is not applied. */
export async function isDatabaseCall(header: string | null): Promise<boolean> {
  if (!header) return false;
  try {
    const { data } = await createAdminClient().from("appointment_sender").select("token").eq("id", 1).maybeSingle();
    const token = (data as { token?: string } | null)?.token;
    if (!token || !/^[0-9a-f]{48}$/.test(token)) return false; // as 0113 makes it (a restored backup has it blanked)
    const want = Buffer.from(token), got = Buffer.from(header);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch { return false; }
}

/** Notes a scheduled check (from the database or GitHub), for the health line in Settings. */
export async function noteScheduledRun(via: "database" | "github", res: SenderResult | { error: string }): Promise<void> {
  try {
    await createAdminClient().from("appointment_sender").update({ last_run_at: new Date().toISOString(), last_via: via, last_result: res }).eq("id", 1);
  } catch { /* not set up yet */ }
}

export interface SenderStatus { ready: boolean; registered: boolean; lastRunAt: string | null; lastVia: string | null; note: string | null }
/** For Settings: is the 5-minute check set up, and when did a scheduled check last run. */
export async function senderStatus(): Promise<SenderStatus> {
  await ensureSenderUrl();
  try {
    const { data, error } = await createAdminClient().from("appointment_sender").select("url, last_run_at, last_via, last_result").eq("id", 1).maybeSingle();
    if (error || !data) return { ready: false, registered: false, lastRunAt: null, lastVia: null, note: null };
    const d = data as { url: string | null; last_run_at: string | null; last_via: string | null; last_result: { note?: string; error?: string } | null };
    const note = d.last_result?.error ?? (d.last_result?.note && d.last_result.note !== "automatic messages are off" ? d.last_result.note : null);
    return { ready: true, registered: !!d.url, lastRunAt: d.last_run_at, lastVia: d.last_via, note };
  } catch { return { ready: false, registered: false, lastRunAt: null, lastVia: null, note: null }; }
}

/** Every template the sender can send, for the Settings campaign list. */
export const SENDABLE = Object.keys(TEMPLATES);
