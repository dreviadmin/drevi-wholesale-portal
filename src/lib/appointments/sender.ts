import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendTemplateMessage } from "@/lib/aisensy";
import { orderTagBlocker } from "@/lib/wallet-core";
import { loadConfig, APPT_COLS } from "./server";
import { TEMPLATES, dayShort, fromIst, hm, isLive, istParts, renderParams, type Appt, type Config } from "./core";

// The appointment message sender, run every 10 minutes by /api/cron/appointments.
//
// Order of safety checks for every due row (each one ends the row as "skipped"
// with its reason, never "sent"):
//   1. automatic messages switched off in Settings: nothing is claimed at all;
//      rows past their expiry are marked "Too late to send" by the claim, so
//      turning the switch on later never floods anyone with old alerts.
//   2. not production (a dev deploy, or production code pointed at the dev
//      database): only numbers on the test list are ever messaged.
//   3. test mode: every message goes to the test numbers instead of the person.
//   4. no AiSensy key for the customer number, or no campaign for the template.
//   5. the booking is no longer live (for reminders), or the customer said no
//      to WhatsApp.
//   6. a moved or cancelled note that is no longer true (Undo, a later cancel),
//      or a customer message whose number has since been corrected.
// A send that times out is "uncertain" and is never retried automatically.

type Row = { id: string; appointment_id: string | null; rule: string; template: string; audience: string; recipient_name: string | null; to_address: string; params: Record<string, unknown> | null; due_at: string };
const REMINDER_RULES = new Set(["c-confirm", "c-24h", "c-2h", "s-heads-up", "s-pending"]);

export interface SenderResult { automation: boolean; testMode: boolean; claimed: number; sent: number; failed: number; uncertain: number; skipped: number; digests: number; note?: string }

export async function runAppointmentSender(now = new Date()): Promise<SenderResult> {
  const admin = createAdminClient();
  const c = await loadConfig();
  if (!c.ok) return { automation: false, testMode: true, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0, digests: 0, note: c.missing ? "not set up" : c.error };
  const cfg = c.data, set = cfg.settings;
  const out: SenderResult = { automation: set.automation_on, testMode: set.test_mode, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0, digests: 0 };

  if (!set.automation_on) {
    await admin.rpc("appt_claim_messages", { p_limit: 0 }); // only expires stale rows
    out.note = "automatic messages are off";
    return out;
  }
  out.digests = await queueDailyList(cfg, now);

  const { data: claimed, error } = await admin.rpc("appt_claim_messages", { p_limit: 30 });
  if (error) { out.note = error.message; return out; }
  const rows = (claimed ?? []) as Row[];
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
  const apiKey = process.env.AISENSY_APPT_API_KEY?.trim() || "";
  const prod = orderTagBlocker({ VERCEL_ENV: process.env.VERCEL_ENV, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL }) === null;
  const tests = set.test_numbers ?? [];

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
    if (!apiKey) return finish(r, "skipped", { reason: "The AiSensy key for the customer number is not set" });
    const campaign = set.campaigns?.[r.template];
    if (!campaign) return finish(r, "skipped", { reason: "No AiSensy campaign set for this message in Settings" });
    let to = r.to_address;
    if (set.test_mode) { if (!tests.length) return finish(r, "skipped", { reason: "Test mode is on and there is no test number" }); to = tests[0]; }
    if (!prod && !tests.includes(to)) return finish(r, "skipped", { reason: "Not production: only test numbers are messaged" });
    let params: string[];
    try { params = renderParams(r.template, a, { types: cfg.types, ...contextFor(r, a, cfg) }); }
    catch (e) { return finish(r, "failed", { last_error: (e as Error).message }); }
    const res = await sendTemplateMessage({ apiKey, campaignName: campaign, destination: to, userName: r.recipient_name || "Customer", params, tags: ["appointments", r.audience] });
    if (res.sent) return finish(r, "sent", { sent_at: new Date().toISOString(), last_error: null, reason: set.test_mode ? `Test mode: sent to ${to}` : null });
    return finish(r, res.uncertain ? "uncertain" : "failed", { last_error: res.error ?? "unknown" });
  });
  // Six at a time, so 30 rows at an 8 s timeout stay inside the 60 s function limit.
  for (let i = 0; i < work.length; i += 6) await Promise.all(work.slice(i, i + 6).map((f) => f().catch(() => undefined)));
  return out;
}

function contextFor(r: Row, a: Appt | null, cfg: Config): { change?: string; byName?: string; reason?: string; digest?: { count: number; list: string } } {
  if (r.template === "drevi_staff_today") return { digest: r.params?.digest as { count: number; list: string } };
  if (!a) return {};
  if (r.template === "drevi_staff_changed") {
    const p = istParts(a.starts_at);
    return { change: r.params?.kind === "cancelled" ? "cancelled" : `moved to ${dayShort(p.day)} at ${hm(p.min)}`, byName: String(r.params?.by ?? "staff") };
  }
  if (r.template === "drevi_appt_cancelled") return { reason: a.cancel_reason === "Shop closed" ? "The shop is closed then. We are sorry for the trouble." : "We are sorry for any trouble." };
  void cfg;
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

/** Every template the sender can send, for the Settings campaign list. */
export const SENDABLE = Object.keys(TEMPLATES);
