import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { Appt, ApptSettings, Block, Closure, Config, HoursRow, Person, ApptType } from "./core";

// Reads for the Appointments screens and the sender. All through the service
// role (the tables have no policies). If 0110/0111 are not applied yet, every
// reader answers { missing: true } instead of throwing, so the screens can say
// so and Home stays up.

export type Loaded<T> = { ok: true; data: T } | { ok: false; missing: boolean; error: string };
const isMissing = (msg: string) => /relation .* does not exist|Could not find the table|schema cache/i.test(msg);
function fail<T>(e: unknown): Loaded<T> { const m = (e as Error)?.message ?? String(e); return { ok: false, missing: isMissing(m), error: m }; }

export const APPT_COLS = "id, number, type_id, place, party, starts_at, ends_at, status, source, customer_name, phone_e164, email, functions, function_date, looking_for, staff_notes, meet_link, host_staff_id, notify_wa, notify_email, offers_ok, outcome, cancel_reason, manage_token, created_by, created_at, confirmed_at, cancelled_at, updated_at, rev";

/** Types, hours, closures and blocks from two days ago (or from sinceDay, for a past calendar week), settings, people. */
export async function loadConfig(sinceDay?: string): Promise<Loaded<Config>> {
  const admin = createAdminClient();
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  const sd = sinceDay && /^\d{4}-\d{2}-\d{2}$/.test(sinceDay) ? new Date(`${sinceDay}T00:00:00+05:30`) : null;
  const early = !!sd && !Number.isNaN(sd.getTime()) && sd.getTime() < Date.now() - 2 * 86400000;
  const since = early ? sd!.toISOString() : twoDaysAgo;
  const sinceDayStr = early ? sinceDay! : twoDaysAgo.slice(0, 10);
  try {
    const [types, hours, closures, blocks, settings, people] = await Promise.all([
      admin.from("appointment_types").select("*").order("sort"),
      admin.from("appointment_hours").select("weekday, opens, closes").order("weekday"),
      admin.from("appointment_closures").select("day, opens, closes, note").gte("day", sinceDayStr).order("day"),
      admin.from("appointment_blocks").select("id, starts_at, ends_at, takes, note").gte("ends_at", since).order("starts_at"),
      admin.from("appointment_settings").select("*").eq("id", 1).maybeSingle(),
      admin.from("appointment_people").select("*").order("created_at"),
    ]);
    for (const r of [types, hours, closures, blocks, settings, people]) if (r.error) throw new Error(r.error.message);
    // Someone whose portal login has been switched off stops getting booking details on WhatsApp.
    const linked = [...new Set(((people.data ?? []) as Person[]).map((p) => p.staff_id).filter(Boolean))] as string[];
    const offLogins = new Set<string>();
    if (linked.length) {
      const { data: logins, error: lErr } = await admin.from("staff_users").select("id, active").in("id", linked);
      if (lErr) throw new Error(lErr.message);
      for (const l of (logins ?? []) as Array<{ id: string; active: boolean }>) if (!l.active) offLogins.add(l.id);
    }
    const s = settings.data as (ApptSettings & { campaigns: Record<string, string> | null }) | null;
    return {
      ok: true,
      data: {
        types: (types.data ?? []) as ApptType[],
        hours: ((hours.data ?? []) as HoursRow[]).map((h) => ({ ...h, opens: h.opens?.slice(0, 5) ?? null, closes: h.closes?.slice(0, 5) ?? null })),
        closures: ((closures.data ?? []) as Closure[]).map((c) => ({ ...c, opens: c.opens?.slice(0, 5) ?? null, closes: c.closes?.slice(0, 5) ?? null })),
        blocks: (blocks.data ?? []) as Block[],
        settings: s ? { ...s, campaigns: s.campaigns ?? {} } : { stylists: 2, step_minutes: 30, website_confirm: "instant", automation_on: false, test_mode: true, test_numbers: [], digest_hour: 11, campaigns: {} },
        people: ((people.data ?? []) as Person[]).map((p) => (p.staff_id && offLogins.has(p.staff_id) ? { ...p, active: false } : p)),
      },
    };
  } catch (e) { return fail(e); }
}

/** Upcoming confirmed bookings whose WhatsApp confirmation has not gone yet: someone sends it by hand
 *  (the booking page's button marks it sent). While automatic messages are on, only the ones that failed
 *  or were skipped count, since the rest go out within 10 minutes. Empty on any error. */
export async function unsentConfirmations(now = new Date()): Promise<Set<string>> {
  try {
    const admin = createAdminClient();
    const { data: s } = await admin.from("appointment_settings").select("automation_on").eq("id", 1).maybeSingle();
    const states = (s as { automation_on?: boolean } | null)?.automation_on ? ["skipped", "failed"] : ["scheduled", "skipped", "failed"];
    const { data, error } = await admin.from("appointment_messages").select("appointment_id, appointments!inner(starts_at, status)")
      .eq("rule", "c-confirm").in("state", states).gte("appointments.starts_at", now.toISOString()).eq("appointments.status", "confirmed");
    if (error) return new Set();
    return new Set(((data ?? []) as Array<{ appointment_id: string | null }>).map((r) => r.appointment_id).filter(Boolean) as string[]);
  } catch { return new Set(); }
}

/** Bookings starting in [fromIso, toIso). */
export async function listAppointments(fromIso: string, toIso: string): Promise<Loaded<Appt[]>> {
  try {
    const rows = await fetchAll<Appt>(createAdminClient(), "appointments", APPT_COLS, (q) => q.gte("starts_at", fromIso).lt("starts_at", toIso).order("starts_at").order("id"));
    return { ok: true, data: rows };
  } catch (e) { return fail(e); }
}

/** Search every booking by name, number or phone digits (newest first, at most 200). */
export async function searchAppointments(q: string): Promise<Loaded<Appt[]>> {
  const admin = createAdminClient(), t = q.trim(), digits = t.replace(/\D/g, "");
  try {
    let query = admin.from("appointments").select(APPT_COLS).order("starts_at", { ascending: false }).limit(200);
    if (/^a-?\d+$/i.test(t)) query = query.eq("number", "A-" + t.replace(/\D/g, ""));
    else if (/^\d{4,6}$/.test(t)) query = query.or(`number.eq.A-${t},phone_e164.like.*${t}*`); // a booking number typed without the A-
    else if (digits.length >= 4) query = query.like("phone_e164", `%${digits.slice(-10)}%`);
    else if (t) query = query.ilike("customer_name", `%${t.replace(/[%_]/g, "")}%`);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { ok: true, data: (data ?? []) as Appt[] };
  } catch (e) { return fail(e); }
}

export interface ApptEvent { id: number; at: string; by_name: string; kind: string; text: string }
export interface ApptMessage { id: string; rule: string; template: string; channel: string; audience: string; recipient_name: string | null; to_address: string; due_at: string; expires_at: string | null; state: string; reason: string | null; attempts: number; last_error: string | null; sent_at: string | null; created_at: string }
export async function getAppointment(number: string): Promise<Loaded<{ appt: Appt; events: ApptEvent[]; messages: ApptMessage[]; others: Array<Pick<Appt, "number" | "starts_at" | "status">> } | null>> {
  const admin = createAdminClient();
  try {
    const { data: a, error } = await admin.from("appointments").select(APPT_COLS).eq("number", number).maybeSingle();
    if (error) throw new Error(error.message);
    if (!a) return { ok: true, data: null };
    const appt = a as Appt;
    const [ev, ms, others] = await Promise.all([
      admin.from("appointment_events").select("id, at, by_name, kind, text").eq("appointment_id", appt.id).order("at", { ascending: false }).limit(200),
      admin.from("appointment_messages").select("id, rule, template, channel, audience, recipient_name, to_address, due_at, expires_at, state, reason, attempts, last_error, sent_at, created_at").eq("appointment_id", appt.id).order("due_at").limit(200),
      admin.from("appointments").select("number, starts_at, status").eq("phone_e164", appt.phone_e164).neq("id", appt.id).order("starts_at", { ascending: false }).limit(10),
    ]);
    for (const r of [ev, ms, others]) if (r.error) throw new Error(r.error.message);
    return { ok: true, data: { appt, events: (ev.data ?? []) as ApptEvent[], messages: (ms.data ?? []) as ApptMessage[], others: (others.data ?? []) as Array<Pick<Appt, "number" | "starts_at" | "status">> } };
  } catch (e) { return fail(e); }
}

/** Messages due in a window, for the Messages screen. */
export async function listMessages(fromIso: string, toIso: string): Promise<Loaded<Array<ApptMessage & { appointment_id: string | null; number?: string | null }>>> {
  const admin = createAdminClient();
  try {
    const rows = await fetchAll<ApptMessage & { appointment_id: string | null; appointments: { number: string } | null }>(admin, "appointment_messages",
      "id, appointment_id, rule, template, channel, audience, recipient_name, to_address, due_at, expires_at, state, reason, attempts, last_error, sent_at, created_at, appointments(number)",
      (q) => q.gte("due_at", fromIso).lt("due_at", toIso).order("due_at").order("id"));
    return { ok: true, data: rows.map((r) => ({ ...r, number: r.appointments?.number ?? null })) };
  } catch (e) { return fail(e); }
}

/** Active staff who can host (for the Stylist pickers). */
export async function listStaff(): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const { data } = await createAdminClient().from("staff_users").select("id, name, email, role, active").eq("active", true).order("name");
  return ((data ?? []) as Array<{ id: string; name: string | null; email: string; role: string }>).map((s) => ({ id: s.id, name: s.name || s.email.split("@")[0], email: s.email, role: s.role }));
}
