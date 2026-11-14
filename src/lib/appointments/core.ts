// Appointments (0110/0111): the pure parts, shared by the portal screens, the
// sender and (later) the website API. No database or network here, so all of
// it is unit-tested in core.test.ts.
//
// Times: the shop runs on India time (IST, UTC+05:30, no daylight saving). A
// "day" is "YYYY-MM-DD" in IST and a time of day is minutes after IST
// midnight. Stored timestamps are timestamptz.

export type Place = "store" | "wa" | "meet";
export type Party = "solo" | "group";
export type ApptStatus = "requested" | "confirmed" | "arrived" | "done" | "no_show" | "cancelled";
export type ApptSource = "website" | "phone" | "whatsapp" | "instagram" | "walkin" | "other";
export type MsgState = "scheduled" | "sending" | "sent" | "failed" | "uncertain" | "cancelled" | "skipped";

export interface ApptType {
  id: string; name: string; short_name: string; minutes: number; group_minutes: number; buffer_minutes: number;
  notice_hours: number; window_days: number; places: Place[]; active: boolean; sort: number;
}
export interface HoursRow { weekday: number; opens: string | null; closes: string | null }
export interface Closure { day: string; opens: string | null; closes: string | null; note: string | null }
export interface Block { id: string; starts_at: string; ends_at: string; takes: number; note: string | null }
export interface ApptSettings {
  stylists: number; step_minutes: number; website_confirm: "instant" | "staff"; automation_on: boolean; test_mode: boolean;
  test_numbers: string[]; digest_hour: number; campaigns: Record<string, string>;
}
export interface Person {
  id: string; name: string; staff_id: string | null; wa_e164: string | null; email: string | null;
  on_new: boolean; on_change: boolean; on_digest: boolean; on_heads_up: boolean; active: boolean;
}
export interface Appt {
  id: string; number: string; type_id: string; place: Place; party: Party; starts_at: string; ends_at: string; status: ApptStatus;
  source: ApptSource; customer_name: string; phone_e164: string; email: string | null; functions: string[]; function_date: string | null;
  looking_for: string | null; staff_notes: string | null; meet_link: string | null; host_staff_id: string | null;
  notify_wa: boolean; notify_email: boolean; offers_ok: boolean; outcome: string | null; cancel_reason: string | null;
  manage_token: string; created_by: string | null; created_at: string; confirmed_at: string | null; cancelled_at: string | null;
  updated_at: string; rev: number;
}
export interface Config { types: ApptType[]; hours: HoursRow[]; closures: Closure[]; blocks: Block[]; settings: ApptSettings; people: Person[] }

export const LIVE: ApptStatus[] = ["requested", "confirmed", "arrived"];
export const isLive = (s: ApptStatus) => LIVE.includes(s);
export const PLACE_LABEL: Record<Place, string> = { store: "At the store", wa: "WhatsApp video", meet: "Google Meet" };
export const STATUS_LABEL: Record<ApptStatus, string> = { requested: "Needs confirming", confirmed: "Confirmed", arrived: "Arrived", done: "Done", no_show: "No-show", cancelled: "Cancelled" };
export const SOURCE_LABEL: Record<ApptSource, string> = { website: "Website", phone: "Phone call", whatsapp: "WhatsApp", instagram: "Instagram", walkin: "At the shop", other: "Other" };
export const FUNCTIONS = ["Haldi", "Mehendi", "Carnival", "Sangeet", "Cocktail", "Reception or wedding day", "Other"];
export const OUTCOMES = ["Bought", "Will come back", "Asked for photos", "Custom order", "Not interested"];
export const CANCEL_REASONS = ["Customer's plans changed", "Customer found something else", "Booked by mistake", "Shop closed", "Other"];
export const SHOP_ADDRESS = "Shop No. 11, Sai Ganesh Sadan, Ground floor, Senapati Bapat Marg, Dadar West, Mumbai 400028";
/** What the customer hears the type called: "your store visit", "your video shopping call". */
export const TYPE_SPOKEN: Record<string, string> = { store: "store visit", video: "video shopping call", design: "custom design consultation" };

/* ---------------- India time ---------------- */
const IST_MIN = 330;
const pad = (n: number) => (n < 10 ? "0" : "") + n;
export function istParts(d: Date | string): { day: string; min: number } {
  const t = new Date(new Date(d).getTime() + IST_MIN * 60000);
  return { day: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`, min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
export function fromIst(day: string, min: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0) + (min - IST_MIN) * 60000);
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function weekday(day: string): number { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function dayDiff(a: string, b: string): number { const p = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 86400000); }
export const parseHm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
export function hm(min: number): string { const h = Math.floor(min / 60) % 24, m = min % 60, ap = h >= 12 ? "pm" : "am"; return `${h % 12 || 12}${m ? ":" + pad(m) : ""} ${ap}`; }
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], DOWL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dayShort(day: string): string { const [, m, d] = day.split("-").map(Number); return `${DOW[weekday(day)]} ${d} ${MON[m - 1]}`; }
export function dayLong(day: string): string { const [, m, d] = day.split("-").map(Number); return `${DOWL[weekday(day)]} ${d} ${MONL[m - 1]}`; }
export function dayLabel(day: string, today: string): string {
  const diff = dayDiff(today, day);
  return diff === 0 ? `Today, ${dayShort(day)}` : diff === 1 ? `Tomorrow, ${dayShort(day)}` : diff === -1 ? `Yesterday, ${dayShort(day)}` : dayShort(day);
}
export function durOf(t: ApptType, party: Party): number { return party === "group" ? t.group_minutes : t.minutes; }

/* ---------------- opening hours and free slots ---------------- */
export function hoursFor(cfg: Pick<Config, "hours" | "closures">, day: string): { open: number; close: number; note?: string; special?: boolean } | { closed: true; note?: string } {
  const c = cfg.closures.find((x) => x.day === day);
  if (c) return c.opens && c.closes ? { open: parseHm(c.opens), close: parseHm(c.closes), note: c.note ?? undefined, special: true } : { closed: true, note: c.note ?? undefined };
  const h = cfg.hours.find((x) => x.weekday === weekday(day));
  return h && h.opens && h.closes ? { open: parseHm(h.opens), close: parseHm(h.closes) } : { closed: true };
}

/** Same rule as appt_conflict() in 0111: the busiest moment in [start, end + gap after) must stay under the stylists. */
export function conflictAt(cfg: Config, appts: Appt[], o: { typeId: string; start: Date; end: Date; place: Place; host?: string | null; exclude?: string | null }): "full" | "video_busy" | "host_busy" | null {
  const t = cfg.types.find((x) => x.id === o.typeId);
  const winEnd = o.end.getTime() + (t?.buffer_minutes ?? 0) * 60000, s0 = o.start.getTime();
  const iv: Array<{ s: number; e: number; w: number }> = [];
  for (const a of appts) {
    if (!isLive(a.status) || a.id === o.exclude) continue;
    const at = cfg.types.find((x) => x.id === a.type_id), s = new Date(a.starts_at).getTime(), e = new Date(a.ends_at).getTime() + (at?.buffer_minutes ?? 0) * 60000;
    if (s < winEnd && s0 < e) iv.push({ s, e, w: 1 });
  }
  for (const b of cfg.blocks) { const s = new Date(b.starts_at).getTime(), e = new Date(b.ends_at).getTime(); if (s < winEnd && s0 < e) iv.push({ s, e, w: b.takes }); }
  const pts = [s0, ...iv.map((x) => x.s).filter((s) => s > s0 && s < winEnd)];
  const peak = Math.max(0, ...pts.map((p) => iv.filter((x) => x.s <= p && p < x.e).reduce((n, x) => n + x.w, 0)));
  if (peak >= cfg.settings.stylists) return "full";
  const overlapsPlain = (a: Appt) => isLive(a.status) && a.id !== o.exclude && new Date(a.starts_at).getTime() < o.end.getTime() && s0 < new Date(a.ends_at).getTime();
  if ((o.place === "wa" || o.place === "meet") && appts.some((a) => overlapsPlain(a) && (a.place === "wa" || a.place === "meet"))) return "video_busy";
  if (o.host && appts.some((a) => overlapsPlain(a) && a.host_staff_id === o.host)) return "host_busy";
  return null;
}
export const CONFLICT_LABEL: Record<string, string> = { full: "Both stylists are busy", video_busy: "Another video call is on then", host_busy: "That stylist is busy then" };

export interface Slot { min: number; start: Date; end: Date; free: boolean; why: string | null }
/** Every start time on a day for a type, free or not. Staff see full ones greyed (and owners/admins may book over the limit). */
export function slotsFor(cfg: Config, appts: Appt[], o: { typeId: string; day: string; place: Place; party: Party; host?: string | null; exclude?: string | null; now: Date; staff: boolean }): Slot[] {
  const t = cfg.types.find((x) => x.id === o.typeId); if (!t) return [];
  const h = hoursFor(cfg, o.day); if ("closed" in h) return [];
  const today = istParts(o.now).day, ahead = dayDiff(today, o.day);
  if (ahead < 0 || (!o.staff && (ahead > t.window_days || !t.active))) return [];
  const dur = durOf(t, o.party), out: Slot[] = [];
  for (let m = h.open; m + dur <= h.close; m += cfg.settings.step_minutes) {
    const start = fromIst(o.day, m), end = fromIst(o.day, m + dur);
    const lead = (start.getTime() - o.now.getTime()) / 60000;
    if (lead < (o.staff ? -dur : t.notice_hours * 60)) continue; // staff may still enter one that has just begun
    const c = conflictAt(cfg, appts, { typeId: t.id, start, end, place: o.place, host: o.host, exclude: o.exclude });
    out.push({ min: m, start, end, free: !c, why: c ? CONFLICT_LABEL[c] : null });
  }
  return out;
}

/* ---------------- phone numbers ---------------- */
/** +E.164 or null. Accepts "98765 43210", "098765 43210", "+91 98765 43210", "919876543210" with India, and any "+code …" number. */
export function parsePhone(raw: string, cc = "+91"): string | null {
  const t = String(raw ?? "").trim(); let d = t.replace(/\D/g, ""); const c = cc.replace(/\D/g, "") || "91";
  if (/^(\+|00)/.test(t)) { d = d.replace(/^00/, ""); if (d.startsWith("91")) return /^91[6-9]\d{9}$/.test(d) ? `+${d}` : null; return /^[1-9]\d{7,14}$/.test(d) ? `+${d}` : null; }
  if (c === "91") { if (d.length === 12 && d.startsWith("91")) d = d.slice(2); if (d.length === 11 && d.startsWith("0")) d = d.slice(1); return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null; }
  if (d.startsWith(c) && d.length > c.length + 6) d = d.slice(c.length);
  d = d.replace(/^0+/, "");
  return d.length >= 6 && (c + d).length <= 15 ? `+${c}${d}` : null;
}
export function showPhone(e164: string): string { const m = /^\+91(\d{5})(\d{5})$/.exec(e164); return m ? `+91 ${m[1]} ${m[2]}` : e164; }
/** wa.me needs digits only. */
export const waDigits = (e164: string) => e164.replace(/\D/g, "");

/* ---------------- WhatsApp templates (Utility) ----------------
   Meta's rules, checked by lintTemplate(): the body never starts or ends with
   a variable, no two variables touch, a value is one line. Phase 1 has no
   buttons: customers reply in the chat, which reaches the shop phone. */
export interface Tpl { name: string; title: string; audience: "client" | "staff"; vars: string[]; body: string }
export const TEMPLATES: Record<string, Tpl> = {
  drevi_appt_confirmed: { name: "drevi_appt_confirmed", title: "Booking confirmed", audience: "client", vars: ["name", "type", "date", "time", "number", "where"],
    body: "Hi {{1}}, your {{2}} with Drevi is booked for {{3}} at {{4}}.\nBooking {{5}}.\n{{6}}\nTo change the time, just reply to this message." },
  drevi_appt_reminder_day: { name: "drevi_appt_reminder_day", title: "Reminder a day before", audience: "client", vars: ["name", "type", "date", "time", "where"],
    body: "Hi {{1}}, a reminder of your {{2}} with Drevi tomorrow, {{3}} at {{4}}.\n{{5}}\nTo change the time, just reply to this message." },
  drevi_appt_reminder_soon: { name: "drevi_appt_reminder_soon", title: "Reminder 2 hours before", audience: "client", vars: ["name", "time", "type", "soon"],
    body: "Hi {{1}}, see you at {{2}} today for your {{3}}.\n{{4}}\nRunning late? Just reply to this message." },
  drevi_appt_moved: { name: "drevi_appt_moved", title: "Moved", audience: "client", vars: ["name", "type", "date", "time", "number"],
    body: "Hi {{1}}, your {{2}} with Drevi has moved to {{3}} at {{4}}.\nBooking {{5}}. If that time does not suit you, just reply to this message." },
  drevi_appt_cancelled: { name: "drevi_appt_cancelled", title: "Cancelled", audience: "client", vars: ["name", "type", "date", "time", "reason"],
    body: "Hi {{1}}, your {{2}} with Drevi on {{3}} at {{4}} is cancelled.\n{{5}}\nIf you have any questions, just reply to this message." },
  drevi_staff_new_booking: { name: "drevi_staff_new_booking", title: "New booking (staff)", audience: "staff", vars: ["number", "type", "date", "time", "customer", "phone", "functions", "fdate", "looking", "place", "source"],
    body: "New appointment {{1}}: {{2}} on {{3}} at {{4}}.\nCustomer: {{5}}, {{6}}.\nFunction: {{7}}. Function date: {{8}}.\nLooking for: {{9}}.\nPlace: {{10}}. Booked via {{11}}.\nOpen the portal for details." },
  drevi_staff_changed: { name: "drevi_staff_changed", title: "Moved or cancelled (staff)", audience: "staff", vars: ["number", "customer", "change", "by"],
    body: "Booking {{1}} for {{2}}: {{3}}. Changed by {{4}}.\nOpen the portal for details." },
  drevi_staff_today: { name: "drevi_staff_today", title: "Today's appointments (staff)", audience: "staff", vars: ["count", "list"],
    body: "Good morning. Drevi has {{1}} appointments today: {{2}}.\nOpen the portal for details." },
  drevi_staff_heads_up: { name: "drevi_staff_heads_up", title: "Heads-up 30 minutes before (staff)", audience: "staff", vars: ["customer", "type", "time", "place", "looking"],
    body: "In 30 minutes: {{1}}, {{2}} at {{3}} ({{4}}).\nLooking for: {{5}}.\nOpen the portal for the notes." },
  drevi_staff_needs_confirming: { name: "drevi_staff_needs_confirming", title: "Still needs confirming (staff)", audience: "staff", vars: ["number", "customer", "type", "date", "time"],
    body: "Booking {{1}} still needs confirming: {{2}}, {{3}} on {{4}} at {{5}}.\nCall or WhatsApp them, then confirm it in the portal." },
};
export function lintTemplate(t: Tpl): string[] {
  const issues: string[] = [], nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.length !== t.vars.length || uniq.some((n, i) => n !== i + 1)) issues.push(`variables ${uniq.join(",")} do not match ${t.vars.length} names`);
  if (/^\s*\{\{/.test(t.body)) issues.push("starts with a variable");
  if (/\}\}\s*$/.test(t.body)) issues.push("ends with a variable");
  if (/\}\}\s*\{\{/.test(t.body)) issues.push("two variables touch");
  if (t.body.length > 1024) issues.push("longer than 1024");
  return issues;
}
/** One-line value Meta accepts: no newlines or tabs, no 4+ spaces, not empty, capped. */
export function cleanParam(v: unknown, max = 160): string {
  let s = String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s || "not given";
}
/** "Mrs. Ananya Mehta" -> "Ananya". */
export function firstName(full: string): string {
  const parts = full.trim().split(/\s+/).filter((p) => !/^(mr|mrs|ms|miss|dr|smt|shri)\.?$/i.test(p));
  return parts[0] || full.trim() || "there";
}
function timeFor(a: Appt): string { const t = hm(istParts(a.starts_at).min); return a.phone_e164.startsWith("+91") ? t : `${t} India time`; }
function whereFor(a: Appt): string {
  return a.place === "store" ? `Our store: ${SHOP_ADDRESS}.` : a.place === "wa" ? "We will video call you on WhatsApp from this number." : a.meet_link ? `Join on Google Meet: ${a.meet_link}` + "." : "We will send the Google Meet link here before the call.";
}
function soonFor(a: Appt): string {
  return a.place === "store" ? `Our store: ${SHOP_ADDRESS}.` : a.place === "wa" ? "Keep WhatsApp open: we will video call you from this number." : a.meet_link ? `Join here: ${a.meet_link}` + "." : "Your Google Meet link will follow in this chat.";
}
export interface RenderCtx { types: ApptType[]; hostName?: string | null; byName?: string; change?: string; reason?: string; digest?: { count: number; list: string } }
/** Template variables in order, ready for AiSensy's templateParams. */
export function renderParams(tplName: string, a: Appt | null, ctx: RenderCtx): string[] {
  const tpl = TEMPLATES[tplName]; if (!tpl) throw new Error(`unknown template ${tplName}`);
  const t = a ? ctx.types.find((x) => x.id === a.type_id) : null, p = a ? istParts(a.starts_at) : null;
  const v: Record<string, string> = a && p ? {
    name: firstName(a.customer_name), customer: a.customer_name, type: TYPE_SPOKEN[a.type_id] ?? (t?.name.toLowerCase() || "appointment"),
    date: dayLong(p.day), time: timeFor(a), number: a.number, where: whereFor(a), soon: soonFor(a), phone: showPhone(a.phone_e164),
    functions: a.functions.length ? a.functions.join(", ") : "not given", fdate: a.function_date || "not given", looking: a.looking_for || "not said",
    place: PLACE_LABEL[a.place], source: SOURCE_LABEL[a.source], change: ctx.change || "changed", by: ctx.byName || "staff",
    reason: ctx.reason || "We are sorry for any trouble.",
  } : {};
  if (ctx.digest) { v.count = String(ctx.digest.count); v.list = ctx.digest.list; }
  return tpl.vars.map((k) => cleanParam(v[k], k === "looking" ? 200 : k === "list" ? 600 : 160));
}
export function renderText(tplName: string, params: string[]): string {
  return TEMPLATES[tplName].body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? "");
}

/* ---------------- the message plan ----------------
   What should be queued for a booking given its current state. appt_apply_messages
   (0111) swaps the waiting rows for this list: anything no longer planned is
   cancelled, sent rows are never touched. Content is rendered at send time from
   the booking as it is then, so an edited phone or time is always current. */
export interface PlannedMsg {
  key: string; rule: string; template: string; channel: "wa" | "email"; audience: "client" | "staff"; recipient_name: string; to_address: string;
  due_at: string; expires_at: string | null; state?: MsgState; reason?: string | null; params?: Record<string, unknown>;
}
const iso = (ms: number) => new Date(ms).toISOString();
export function planMessages(a: Appt, cfg: Config, opts: { actorStaffId?: string | null } = {}): PlannedMsg[] {
  const out: PlannedMsg[] = [], start = new Date(a.starts_at).getTime(), made = new Date(a.created_at).getTime(), H = 3600000, M = 60000;
  const people = cfg.people.filter((p) => p.active && p.wa_e164);
  const notActor = (p: Person) => !opts.actorStaffId || p.staff_id !== opts.actorStaffId;
  const add = (m: Omit<PlannedMsg, "key">) => out.push({ ...m, key: `${m.rule}:${m.channel}:${m.to_address}:${m.due_at}` });
  // Staff: a new booking (not to the person who made it).
  for (const p of people.filter((x) => x.on_new && notActor(x)))
    add({ rule: "s-new", template: "drevi_staff_new_booking", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: iso(made), expires_at: iso(made + 2 * H) });
  if (!isLive(a.status)) return out;
  if (a.status === "requested") {
    for (const p of people.filter((x) => x.on_new))
      add({ rule: "s-pending", template: "drevi_staff_needs_confirming", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: iso(made + 2 * H), expires_at: iso(start) });
    return out; // the customer hears nothing until someone confirms
  }
  const confirmedAt = new Date(a.confirmed_at || a.created_at).getTime();
  if (a.notify_wa) {
    add({ rule: "c-confirm", template: "drevi_appt_confirmed", channel: "wa", audience: "client", recipient_name: a.customer_name, to_address: a.phone_e164, due_at: iso(confirmedAt), expires_at: iso(start) });
    if (start - 24 * H > confirmedAt) add({ rule: "c-24h", template: "drevi_appt_reminder_day", channel: "wa", audience: "client", recipient_name: a.customer_name, to_address: a.phone_e164, due_at: iso(start - 24 * H), expires_at: iso(start - 3 * H) });
    if (start - 2 * H > confirmedAt + 30 * M) add({ rule: "c-2h", template: "drevi_appt_reminder_soon", channel: "wa", audience: "client", recipient_name: a.customer_name, to_address: a.phone_e164, due_at: iso(start - 2 * H), expires_at: iso(start - 15 * M) });
  }
  // Staff: the 30-minute heads-up goes to the stylist on the booking if they have it on, else to everyone with it on.
  const host = a.host_staff_id ? people.find((p) => p.staff_id === a.host_staff_id && p.on_heads_up) : null;
  for (const p of host ? [host] : people.filter((x) => x.on_heads_up))
    add({ rule: "s-heads-up", template: "drevi_staff_heads_up", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: iso(start - 30 * M), expires_at: iso(start) });
  return out;
}
/** Messages for one change event (moved or cancelled). Rule names start "ev-": a later edit never withdraws them. */
export function planEvent(a: Appt, cfg: Config, ev: { kind: "moved" | "cancelled"; at: Date; actorStaffId?: string | null; byName?: string; tellClient: boolean }): PlannedMsg[] {
  const out: PlannedMsg[] = [], at = ev.at.getTime(), stamp = iso(at);
  const people = cfg.people.filter((p) => p.active && p.wa_e164 && (p.on_change || (a.host_staff_id && p.staff_id === a.host_staff_id)) && (!ev.actorStaffId || p.staff_id !== ev.actorStaffId));
  const add = (m: Omit<PlannedMsg, "key">) => out.push({ ...m, key: `${m.rule}:${m.channel}:${m.to_address}:${m.due_at}` });
  if (ev.tellClient && a.notify_wa)
    add({ rule: ev.kind === "moved" ? "ev-moved" : "ev-cancelled", template: ev.kind === "moved" ? "drevi_appt_moved" : "drevi_appt_cancelled", channel: "wa", audience: "client",
      recipient_name: a.customer_name, to_address: a.phone_e164, due_at: stamp, expires_at: iso(at + 6 * 3600000) });
  for (const p of people)
    add({ rule: "ev-staff", template: "drevi_staff_changed", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: stamp, expires_at: iso(at + 3 * 3600000), params: { kind: ev.kind, by: ev.byName ?? "staff" } });
  return out;
}

/* ---------------- WhatsApp by hand (works before AiSensy is ready) ---------------- */
export function waLink(e164: string, text: string): string { return `https://wa.me/${waDigits(e164)}?text=${encodeURIComponent(text)}`; }
export function handConfirmText(a: Appt, types: ApptType[]): string { return renderText("drevi_appt_confirmed", renderParams("drevi_appt_confirmed", a, { types })); }
export function handReminderText(a: Appt, types: ApptType[], now: Date): string {
  const sameDay = istParts(a.starts_at).day === istParts(now).day;
  return sameDay ? renderText("drevi_appt_reminder_soon", renderParams("drevi_appt_reminder_soon", a, { types })) : renderText("drevi_appt_reminder_day", renderParams("drevi_appt_reminder_day", a, { types })).replace(" tomorrow,", ",");
}
