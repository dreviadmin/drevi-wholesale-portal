"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff, requireAdmin, isAdminRole, type StaffCtx } from "@/lib/staff";
import { writeAuditEvent } from "@/lib/audit";
import { loadConfig, APPT_COLS } from "@/lib/appointments/server";
import {
  CONFLICT_LABEL, FUNCTIONS, dayShort, durOf, fromIst, hm, hoursFor, istParts, isLive, parsePhone, planEvent, planMessages, slotsFor,
  type Appt, type ApptSource, type Party, type Place, type Config,
} from "@/lib/appointments/core";

type Res<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const who = (s: StaffCtx) => s.name || s.email.split("@")[0];
const SOURCES: ApptSource[] = ["website", "phone", "whatsapp", "instagram", "walkin", "other"];
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

function revalidate(number?: string) {
  revalidatePath("/admin/appointments");
  revalidatePath("/admin/home");
  if (number) revalidatePath(`/admin/appointments/${number}`);
}
async function cfgOrError(): Promise<Config | string> {
  const c = await loadConfig();
  if (!c.ok) return c.missing ? "Appointments are not set up on this database yet (migrations 0110 and 0111)." : c.error;
  return c.data;
}
async function liveAround(startIso: string, endIso: string): Promise<Appt[]> {
  const from = new Date(new Date(startIso).getTime() - 6 * 3600000).toISOString(), to = new Date(new Date(endIso).getTime() + 6 * 3600000).toISOString();
  const { data } = await createAdminClient().from("appointments").select(APPT_COLS).gte("starts_at", from).lt("starts_at", to).in("status", ["requested", "confirmed", "arrived"]);
  return (data ?? []) as Appt[];
}
function insideHours(cfg: Config, start: Date, end: Date): boolean {
  const s = istParts(start), e = istParts(end), h = hoursFor(cfg, s.day);
  return !("closed" in h) && s.day === e.day && s.min >= h.open && (e.min || 1440) <= h.close;
}

/* ================= book ================= */
export interface BookInput {
  typeId: string; place: Place; party: Party; day: string; min: number; status: "confirmed" | "requested"; source: ApptSource;
  name: string; phone: string; cc?: string; email?: string; functions?: string[]; functionDate?: string; lookingFor?: string; staffNotes?: string;
  meetLink?: string; hostStaffId?: string | null; notifyWa: boolean; override?: boolean; idempotencyKey: string;
}
export async function bookAppointment(input: BookInput): Promise<Res<{ number: string }>> {
  let staff: StaffCtx;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  const cfg = await cfgOrError(); if (typeof cfg === "string") return { ok: false, error: cfg };
  const type = cfg.types.find((t) => t.id === input.typeId);
  if (!type) return { ok: false, error: "Pick an appointment type." };
  if (!type.places.includes(input.place)) return { ok: false, error: "That type does not happen there." };
  const phone = parsePhone(input.phone, input.cc || "+91");
  if (!phone) return { ok: false, error: "That WhatsApp number does not look right. A 10-digit Indian mobile, or + and the country code for abroad." };
  const name = clip(input.name, 120);
  if (!name) return { ok: false, error: "Enter the customer's name." };
  if (!SOURCES.includes(input.source)) return { ok: false, error: "Pick where they asked." };
  const meet = clip(input.meetLink, 300);
  if (meet && !/^https:\/\/\S+$/.test(meet)) return { ok: false, error: "The Meet link must start with https://" };
  const override = !!input.override && isAdminRole(staff.role);
  const start = fromIst(input.day, input.min), end = new Date(start.getTime() + durOf(type, input.party) * 60000);
  if (!insideHours(cfg, start, end) && !override) return { ok: false, error: "That is outside opening hours. An owner or admin can book it anyway." };
  if (end.getTime() < Date.now() - 15 * 60000) return { ok: false, error: "That time has already passed." };

  const nowIso = new Date().toISOString();
  const draft: Appt = {
    id: "", number: "", type_id: type.id, place: input.place, party: input.party, starts_at: start.toISOString(), ends_at: end.toISOString(), status: input.status,
    source: input.source, customer_name: name, phone_e164: phone, email: clip(input.email, 200) || null, functions: (input.functions ?? []).filter((f) => FUNCTIONS.includes(f)),
    function_date: clip(input.functionDate, 60) || null, looking_for: clip(input.lookingFor, 600) || null, staff_notes: clip(input.staffNotes, 2000) || null,
    meet_link: meet || null, host_staff_id: input.hostStaffId || null, notify_wa: !!input.notifyWa, notify_email: false, offers_ok: false, outcome: null, cancel_reason: null,
    manage_token: "", created_by: staff.id, created_at: nowIso, confirmed_at: input.status === "confirmed" ? nowIso : null, cancelled_at: null, updated_at: nowIso, rev: 1,
  };
  const messages = planMessages(draft, cfg, { actorStaffId: staff.id });
  const { data, error } = await createAdminClient().rpc("appt_book", { p: {
    type_id: draft.type_id, place: draft.place, party: draft.party, starts_at: draft.starts_at, ends_at: draft.ends_at, status: draft.status, source: draft.source,
    customer_name: draft.customer_name, phone_e164: draft.phone_e164, email: draft.email, functions: draft.functions, function_date: draft.function_date,
    looking_for: draft.looking_for, staff_notes: draft.staff_notes, meet_link: draft.meet_link, host_staff_id: draft.host_staff_id, notify_wa: draft.notify_wa,
    notify_email: false, offers_ok: false, override, idempotency_key: clip(input.idempotencyKey, 80) || null, by_name: who(staff), by_staff_id: staff.id,
    event_text: `Booked by ${who(staff)} (${draft.source === "walkin" ? "at the shop" : "via " + draft.source}). ${type.name}, ${dayShort(input.day)} ${hm(input.min)}.`,
    messages,
  } });
  if (error) return { ok: false, error: error.message };
  const r = data as { ok: boolean; error?: string; number?: string };
  if (!r.ok) return { ok: false, error: CONFLICT_LABEL[r.error ?? ""] ? `${CONFLICT_LABEL[r.error!]}. Pick another time${isAdminRole(staff.role) ? ", or book over the limit" : ""}.` : r.error ?? "Could not book." };
  revalidate(r.number);
  return { ok: true, number: r.number! };
}

/* ================= change ================= */
export type ChangeKind = "move" | "confirm" | "arrived" | "done" | "no_show" | "cancel" | "reopen" | "edit" | "host" | "note" | "meet";
export interface ChangeInput {
  id: string; rev: number; kind: ChangeKind;
  day?: string; min?: number; override?: boolean; tellClient?: boolean;
  outcome?: string; reason?: string; hostStaffId?: string | null; note?: string; meetLink?: string;
  edit?: { name?: string; phone?: string; cc?: string; email?: string; typeId?: string; place?: Place; party?: Party; functions?: string[]; functionDate?: string; lookingFor?: string; staffNotes?: string; notifyWa?: boolean; source?: ApptSource };
}
export async function changeAppointment(input: ChangeInput): Promise<Res<{ rev: number }>> {
  let staff: StaffCtx;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  const cfg = await cfgOrError(); if (typeof cfg === "string") return { ok: false, error: cfg };
  const admin = createAdminClient();
  const { data: cur, error: readErr } = await admin.from("appointments").select(APPT_COLS).eq("id", input.id).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!cur) return { ok: false, error: "That booking is gone." };
  const a = cur as Appt;
  if (a.rev !== input.rev) return { ok: false, error: "Someone else changed this booking a moment ago. It has been reloaded; try again." };
  const isAdmin = isAdminRole(staff.role), now = new Date(), started = new Date(a.starts_at).getTime() <= now.getTime() + 5 * 60000;
  const type = cfg.types.find((t) => t.id === a.type_id)!;
  const patch: Record<string, unknown> = {};
  const next: Appt = { ...a };
  let text = "", eventKind: string = input.kind, ev: "moved" | "cancelled" | null = null;

  switch (input.kind) {
    case "move": {
      if (!isLive(a.status)) return { ok: false, error: "Only a live booking can be moved." };
      if (!input.day || input.min == null) return { ok: false, error: "Pick the new day and time." };
      const s = fromIst(input.day, input.min), e = new Date(s.getTime() + durOf(type, a.party) * 60000);
      if (!insideHours(cfg, s, e) && !(input.override && isAdmin)) return { ok: false, error: "That is outside opening hours." };
      patch.starts_at = next.starts_at = s.toISOString(); patch.ends_at = next.ends_at = e.toISOString();
      const was = istParts(a.starts_at);
      text = `Moved from ${dayShort(was.day)} ${hm(was.min)} to ${dayShort(input.day)} ${hm(input.min)} by ${who(staff)}.`;
      ev = "moved"; break;
    }
    case "confirm":
      if (a.status !== "requested") return { ok: false, error: "It is not waiting to be confirmed." };
      patch.status = next.status = "confirmed"; next.confirmed_at = now.toISOString();
      if (input.tellClient === false) { patch.notify_wa = next.notify_wa = false; }
      text = `Confirmed by ${who(staff)}.` + (next.notify_wa ? " The customer gets the confirmation on WhatsApp." : " The customer was not messaged."); break;
    case "arrived":
      if (!isLive(a.status)) return { ok: false, error: "This booking is not live." };
      if (new Date(a.starts_at).getTime() > now.getTime() + 2 * 3600000) return { ok: false, error: "Arrived opens 2 hours before the time." };
      patch.status = next.status = "arrived"; text = `Arrived. Marked by ${who(staff)}.`; break;
    case "done":
      if (!isLive(a.status)) return { ok: false, error: "This booking is not live." };
      if (!started) return { ok: false, error: "Done opens once the appointment has started." };
      patch.status = next.status = "done"; patch.outcome = next.outcome = clip(input.outcome, 60) || null;
      text = `Done.${next.outcome ? " Outcome: " + next.outcome + "." : ""} Marked by ${who(staff)}.`; break;
    case "no_show":
      if (!isLive(a.status)) return { ok: false, error: "This booking is not live." };
      if (!started) return { ok: false, error: "No-show opens once the time has started." };
      patch.status = next.status = "no_show"; text = `No-show. Marked by ${who(staff)}. No more reminders.`; break;
    case "cancel":
      if (!isLive(a.status)) return { ok: false, error: "This booking is not live." };
      patch.status = next.status = "cancelled"; patch.cancel_reason = next.cancel_reason = clip(input.reason, 120) || null;
      text = `Cancelled by ${who(staff)}${next.cancel_reason ? ": " + next.cancel_reason : ""}.` + (input.tellClient ? " The customer is told on WhatsApp." : " The customer was not messaged.");
      ev = "cancelled"; break;
    case "reopen": {
      if (!isAdmin) return { ok: false, error: "Only an owner or admin can undo this." };
      if (isLive(a.status)) return { ok: false, error: "It is already live." };
      patch.status = next.status = "confirmed"; patch.outcome = null; patch.cancel_reason = null;
      text = `Undone by ${who(staff)}: back to Confirmed (was ${a.status === "no_show" ? "a no-show" : a.status}).`; break;
    }
    case "host":
      patch.host_staff_id = next.host_staff_id = input.hostStaffId || null;
      text = input.hostStaffId ? `Stylist set by ${who(staff)}.` : `Stylist cleared by ${who(staff)}.`; break;
    case "note": {
      const n = clip(input.note, 500); if (!n) return { ok: false, error: "Write the note first." };
      patch.staff_notes = next.staff_notes = (a.staff_notes ? a.staff_notes + "\n" : "") + n;
      text = `Note from ${who(staff)}: ${n}`; break;
    }
    case "meet": {
      const m = clip(input.meetLink, 300);
      if (m && !/^https:\/\/\S+$/.test(m)) return { ok: false, error: "The Meet link must start with https://" };
      patch.meet_link = next.meet_link = m || null; text = m ? `Meet link added by ${who(staff)}.` : `Meet link removed by ${who(staff)}.`; break;
    }
    case "edit": {
      const e = input.edit ?? {}, changes: string[] = [];
      if (e.name !== undefined && clip(e.name, 120) && clip(e.name, 120) !== a.customer_name) { patch.customer_name = next.customer_name = clip(e.name, 120); changes.push("name"); }
      if (e.phone !== undefined) {
        const p = parsePhone(e.phone, e.cc || "+91"); if (!p) return { ok: false, error: "That WhatsApp number does not look right." };
        if (p !== a.phone_e164) { patch.phone_e164 = next.phone_e164 = p; changes.push("WhatsApp number"); }
      }
      if (e.email !== undefined && (clip(e.email, 200) || null) !== a.email) { patch.email = next.email = clip(e.email, 200) || null; changes.push("email"); }
      if (e.functions !== undefined) { patch.functions = next.functions = e.functions.filter((f) => FUNCTIONS.includes(f)); changes.push("functions"); }
      if (e.functionDate !== undefined) { patch.function_date = next.function_date = clip(e.functionDate, 60) || null; changes.push("function date"); }
      if (e.lookingFor !== undefined) { patch.looking_for = next.looking_for = clip(e.lookingFor, 600) || null; changes.push("what they are looking for"); }
      if (e.staffNotes !== undefined) { patch.staff_notes = next.staff_notes = clip(e.staffNotes, 2000) || null; changes.push("notes"); }
      if (e.notifyWa !== undefined && e.notifyWa !== a.notify_wa) { patch.notify_wa = next.notify_wa = e.notifyWa; changes.push(e.notifyWa ? "WhatsApp messages on" : "WhatsApp messages off"); }
      if (e.source !== undefined && SOURCES.includes(e.source) && e.source !== a.source) { patch.source = next.source = e.source; changes.push("where they asked"); }
      let timeChange = false;
      if (e.typeId !== undefined && e.typeId !== a.type_id) { const t2 = cfg.types.find((t) => t.id === e.typeId); if (!t2) return { ok: false, error: "Unknown type." }; patch.type_id = next.type_id = t2.id; changes.push("type"); timeChange = true; }
      if (e.place !== undefined && e.place !== a.place) { patch.place = next.place = e.place; changes.push("place"); timeChange = true; }
      if (e.party !== undefined && e.party !== a.party) { patch.party = next.party = e.party; changes.push("who is coming"); timeChange = true; }
      if (timeChange) {
        const t2 = cfg.types.find((t) => t.id === next.type_id)!;
        if (!t2.places.includes(next.place)) patch.place = next.place = t2.places[0];
        const e2 = new Date(new Date(a.starts_at).getTime() + durOf(t2, next.party) * 60000);
        patch.ends_at = next.ends_at = e2.toISOString();
      }
      if (!changes.length) return { ok: false, error: "Nothing changed." };
      text = `Edited by ${who(staff)}: ${changes.join(", ")}.`; break;
    }
    default: return { ok: false, error: "Unknown change." };
  }

  const messages = [...planMessages(next, cfg, { actorStaffId: a.created_by })];
  if (ev) messages.push(...planEvent(next, cfg, { kind: ev, at: now, actorStaffId: staff.id, byName: who(staff), tellClient: !!input.tellClient || ev === "moved" }));
  const { data, error } = await admin.rpc("appt_update", { p: { id: a.id, expected_rev: a.rev, patch, by_name: who(staff), by_staff_id: staff.id, event_kind: eventKind, event_text: text, override: !!input.override && isAdmin, messages } });
  if (error) return { ok: false, error: error.message };
  const r = data as { ok: boolean; error?: string; rev?: number };
  if (!r.ok) {
    if (r.error === "stale") return { ok: false, error: "Someone else changed this booking a moment ago. Reload and try again." };
    return { ok: false, error: CONFLICT_LABEL[r.error ?? ""] ? `${CONFLICT_LABEL[r.error!]}. Pick another time${isAdmin ? ", or book over the limit" : ""}.` : r.error ?? "Could not save." };
  }
  revalidate(a.number);
  return { ok: true, rev: r.rev! };
}

/** Staff tapped "Send on WhatsApp" (the shop phone sends it by hand). Kept in the history. */
export async function logHandSend(id: string, what: "confirmation" | "reminder" | "meet link" | "message"): Promise<Res> {
  let staff: StaffCtx;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  const { data: a } = await createAdminClient().from("appointments").select("number").eq("id", id).maybeSingle();
  if (!a) return { ok: false, error: "That booking is gone." };
  await createAdminClient().from("appointment_events").insert({ appointment_id: id, by_name: who(staff), by_staff_id: staff.id, kind: "hand_whatsapp", text: `${who(staff)} opened WhatsApp to send the ${what} by hand.` });
  revalidate((a as { number: string }).number);
  return { ok: true };
}

/** For the New appointment and Move screens: every start time that day, free or not. */
export async function slotsForDay(o: { typeId: string; place: Place; party: Party; day: string; hostStaffId?: string | null; exclude?: string | null }): Promise<Res<{ slots: Array<{ min: number; free: boolean; why: string | null }>; note: string | null; closed: boolean }>> {
  try { await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  const cfg = await cfgOrError(); if (typeof cfg === "string") return { ok: false, error: cfg };
  const dayStart = fromIst(o.day, 0).toISOString(), dayEnd = fromIst(o.day, 1440).toISOString();
  const appts = await liveAround(dayStart, dayEnd);
  const h = hoursFor(cfg, o.day);
  const slots = slotsFor(cfg, appts, { typeId: o.typeId, day: o.day, place: o.place, party: o.party, host: o.hostStaffId ?? null, exclude: o.exclude ?? null, now: new Date(), staff: true });
  return { ok: true, slots: slots.map((s) => ({ min: s.min, free: s.free, why: s.why })), note: h.note ?? null, closed: "closed" in h };
}

/* ================= settings (owner and admin) ================= */
async function adminOr(): Promise<StaffCtx | null> { try { return await requireAdmin(); } catch { return null; } }
async function audit(staff: StaffCtx, notes: string) { await writeAuditEvent({ eventType: "appointment_settings_changed", staffUserId: staff.id, notes: `${notes} (by ${staff.email})` }); }

export async function saveType(id: string, v: { minutes: number; group_minutes: number; buffer_minutes: number; notice_hours: number; window_days: number; active: boolean }): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  const n = (x: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(x) || 0)));
  const row = { minutes: n(v.minutes, 5, 480), group_minutes: n(v.group_minutes, 5, 480), buffer_minutes: n(v.buffer_minutes, 0, 120), notice_hours: n(v.notice_hours, 0, 720), window_days: n(v.window_days, 1, 366), active: !!v.active, updated_at: new Date().toISOString() };
  const { error } = await createAdminClient().from("appointment_types").update(row).eq("id", id);
  if (error) return { ok: false, error: error.message };
  await audit(staff, `Appointment type ${id}: ${JSON.stringify(row)}`); revalidate(); return { ok: true };
}
export async function saveHours(rows: Array<{ weekday: number; opens: string | null; closes: string | null }>): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  for (const r of rows) {
    if ((r.opens && !r.closes) || (!r.opens && r.closes)) return { ok: false, error: "Each day needs both an opening and a closing time, or neither." };
    if (r.opens && r.closes && r.closes <= r.opens) return { ok: false, error: "Closing must be after opening." };
  }
  const { error } = await createAdminClient().from("appointment_hours").upsert(rows.map((r) => ({ weekday: r.weekday, opens: r.opens || null, closes: r.closes || null })));
  if (error) return { ok: false, error: error.message };
  await audit(staff, "Appointment hours changed"); revalidate(); return { ok: true };
}
export async function saveClosure(c: { day: string; opens?: string | null; closes?: string | null; note?: string }): Promise<Res<{ onThatDay: number }>> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.day)) return { ok: false, error: "Pick the day." };
  if ((c.opens && !c.closes) || (!c.opens && c.closes) || (c.opens && c.closes && c.closes <= c.opens)) return { ok: false, error: "Give both times, or leave both empty to close all day." };
  const admin = createAdminClient();
  const { error } = await admin.from("appointment_closures").upsert({ day: c.day, opens: c.opens || null, closes: c.closes || null, note: clip(c.note, 120) || null, created_by: staff.email });
  if (error) return { ok: false, error: error.message };
  const { count } = await admin.from("appointments").select("id", { count: "exact", head: true }).gte("starts_at", fromIst(c.day, 0).toISOString()).lt("starts_at", fromIst(c.day, 1440).toISOString()).in("status", ["requested", "confirmed", "arrived"]);
  await audit(staff, `Closure ${c.day} ${c.opens ?? "closed"}-${c.closes ?? ""}`); revalidate(); return { ok: true, onThatDay: count ?? 0 };
}
export async function removeClosure(day: string): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  const { error } = await createAdminClient().from("appointment_closures").delete().eq("day", day);
  if (error) return { ok: false, error: error.message };
  await audit(staff, `Closure ${day} removed`); revalidate(); return { ok: true };
}
/** Block time: any staff (a walk-in, a stylist off). takes = 1 stylist, or 99 = the whole shop. */
export async function addBlock(b: { day: string; fromMin: number; toMin: number; takes: number; note?: string }): Promise<Res> {
  let staff: StaffCtx;
  try { staff = await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  if (!(b.toMin > b.fromMin)) return { ok: false, error: "The end must be after the start." };
  const { error } = await createAdminClient().from("appointment_blocks").insert({ starts_at: fromIst(b.day, b.fromMin).toISOString(), ends_at: fromIst(b.day, b.toMin).toISOString(), takes: b.takes >= 99 ? 99 : Math.max(1, Math.round(b.takes)), note: clip(b.note, 120) || null, created_by: staff.email });
  if (error) return { ok: false, error: error.message };
  revalidate(); return { ok: true };
}
export async function removeBlock(id: string): Promise<Res> {
  try { await requireStaff(); } catch { return { ok: false, error: "Not authorized" }; }
  const { error } = await createAdminClient().from("appointment_blocks").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate(); return { ok: true };
}
export async function savePerson(p: { id?: string; name: string; wa: string; cc?: string; staffId?: string | null; on_new: boolean; on_change: boolean; on_digest: boolean; on_heads_up: boolean; active: boolean }): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  const wa = parsePhone(p.wa, p.cc || "+91");
  if (!clip(p.name, 80)) return { ok: false, error: "Enter a name." };
  if (!wa) return { ok: false, error: "That WhatsApp number does not look right." };
  const row = { name: clip(p.name, 80), wa_e164: wa, staff_id: p.staffId || null, on_new: !!p.on_new, on_change: !!p.on_change, on_digest: !!p.on_digest, on_heads_up: !!p.on_heads_up, active: !!p.active };
  const admin = createAdminClient();
  const { error } = p.id ? await admin.from("appointment_people").update(row).eq("id", p.id) : await admin.from("appointment_people").insert(row);
  if (error) return { ok: false, error: error.message };
  await audit(staff, `Alert person ${row.name} ${p.id ? "changed" : "added"}`); revalidate(); return { ok: true };
}
export async function removePerson(id: string): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  const { error } = await createAdminClient().from("appointment_people").update({ active: false }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  await audit(staff, `Alert person ${id} switched off`); revalidate(); return { ok: true };
}
export async function saveSettings(v: { stylists?: number; website_confirm?: "instant" | "staff"; automation_on?: boolean; test_mode?: boolean; test_numbers?: string[]; digest_hour?: number; campaigns?: Record<string, string> }): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can change settings." };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: staff.email };
  if (v.stylists !== undefined) patch.stylists = Math.min(20, Math.max(1, Math.round(v.stylists)));
  if (v.website_confirm) patch.website_confirm = v.website_confirm === "staff" ? "staff" : "instant";
  if (v.digest_hour !== undefined) patch.digest_hour = Math.min(12, Math.max(6, Math.round(v.digest_hour)));
  if (v.test_numbers) {
    const nums = v.test_numbers.map((x) => parsePhone(x, "+91")); if (nums.some((x) => !x)) return { ok: false, error: "A test number does not look right." };
    patch.test_numbers = nums;
  }
  if (v.campaigns) patch.campaigns = Object.fromEntries(Object.entries(v.campaigns).map(([k, val]) => [k, clip(val, 120)]).filter(([, val]) => val));
  // Real customers only get messages once the owner turns both switches the right way, and only a super admin may do that.
  if (v.test_mode !== undefined) { if (v.test_mode === false && staff.role !== "super_admin") return { ok: false, error: "Only the owner can turn test mode off." }; patch.test_mode = v.test_mode; }
  if (v.automation_on !== undefined) { if (v.automation_on && staff.role !== "super_admin") return { ok: false, error: "Only the owner can turn automatic messages on." }; patch.automation_on = v.automation_on; }
  const { error } = await createAdminClient().from("appointment_settings").update(patch).eq("id", 1);
  if (error) return { ok: false, error: error.message };
  await audit(staff, `Appointment settings: ${Object.keys(patch).filter((k) => !k.startsWith("updated")).join(", ")}`); revalidate(); return { ok: true };
}
/** Put a failed or uncertain message back in the queue (owner or admin, after checking with the person). */
export async function resendMessage(id: string): Promise<Res> {
  const staff = await adminOr(); if (!staff) return { ok: false, error: "Only an owner or admin can resend." };
  const { error } = await createAdminClient().from("appointment_messages").update({ state: "scheduled", due_at: new Date().toISOString(), expires_at: null, reason: `Sent again by ${who(staff)}`, updated_at: new Date().toISOString() }).eq("id", id).in("state", ["failed", "uncertain", "skipped"]);
  if (error) return { ok: false, error: error.message };
  revalidate(); return { ok: true };
}

