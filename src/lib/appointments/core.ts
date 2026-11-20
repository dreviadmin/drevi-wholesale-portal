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

/* ---------------- WhatsApp templates (Utility, English) ----------------
   Submitted to Meta through AiSensy on the shop's number, +91 84336 59684.
   Store visits and video calls have their own wording: a store visit carries
   the address and a "Get directions" button; a video call says how to join.
   (A custom design consultation uses whichever set fits its place.)
   Meta's rules, checked by lintTemplate(): the body never starts or ends with
   a variable, no two variables touch, a value is one line, sequential {{n}}.
   Customers reply in the chat, which reaches the shop phone. */
export type TplButton = { type: "url"; text: string; url: string } | { type: "reply"; text: string };
export interface Tpl {
  name: string; title: string; audience: "client" | "staff"; group: "visit" | "call" | "staff";
  vars: string[]; header: string; body: string; footer?: string; buttons?: TplButton[];
}
export const SHOP_DIRECTIONS_URL = "https://share.google/q8eWVHSpKXY0H4Z2t"; // the link /pages/visit uses
const ADDRESS = `*Address:* ${SHOP_ADDRESS}`;
const FOOTER = "Drevi · Mon–Sat 12–8 pm, Sun 1–7 pm";
const DIRECTIONS: TplButton = { type: "url", text: "Get directions", url: SHOP_DIRECTIONS_URL };
const reply = (text: string): TplButton => ({ type: "reply", text });
const PORTAL = "Open Appointments in the Drevi portal for the details.";
const T = (t: Tpl): [string, Tpl] => [t.name, t];
export const TEMPLATES: Record<string, Tpl> = Object.fromEntries([
  // ---- store visits (and consultations at the store) ----
  T({ name: "drevi_visit_confirmed", title: "Store visit confirmed", audience: "client", group: "visit", vars: ["name", "what", "date", "time", "number"],
    header: "Your visit is booked", footer: FOOTER, buttons: [DIRECTIONS, reply("Need to reschedule")],
    body: `Hi {{1}}, your {{2}} at Drevi is confirmed.\n\n*Date:* {{3}}\n*Time:* {{4}}\n*Booking no.:* {{5}}\n\n${ADDRESS}\n\nWe look forward to seeing you. To change the time, just reply to this message.` }),
  T({ name: "drevi_visit_reminder_day", title: "Store visit: reminder a day before", audience: "client", group: "visit", vars: ["name", "what", "date", "time"],
    header: "See you tomorrow", footer: FOOTER, buttons: [DIRECTIONS, reply("I'll be there"), reply("Need to reschedule")],
    body: `Hi {{1}}, a reminder of your {{2}} at Drevi tomorrow.\n\n*Date:* {{3}}\n*Time:* {{4}}\n\n${ADDRESS}\n\nTo change the time, just reply to this message.` }),
  T({ name: "drevi_visit_reminder_soon", title: "Store visit: reminder 2 hours before", audience: "client", group: "visit", vars: ["name", "time"],
    header: "See you soon", footer: FOOTER, buttons: [DIRECTIONS, reply("On my way"), reply("Running late")],
    body: `Hi {{1}}, we are expecting you at Drevi today at {{2}}.\n\n${ADDRESS}\n\nRunning late or can't make it? Just reply to this message.` }),
  T({ name: "drevi_visit_moved", title: "Store visit moved", audience: "client", group: "visit", vars: ["name", "what", "date", "time", "number"],
    header: "Your visit has moved", footer: FOOTER, buttons: [DIRECTIONS, reply("Need another time")],
    body: `Hi {{1}}, your {{2}} at Drevi has been moved to a new time.\n\n*Date:* {{3}}\n*Time:* {{4}}\n*Booking no.:* {{5}}\n\n${ADDRESS}\n\nIf the new time doesn't suit you, just reply to this message.` }),
  T({ name: "drevi_visit_cancelled", title: "Store visit cancelled", audience: "client", group: "visit", vars: ["name", "what", "date", "time", "reason"],
    header: "Visit cancelled", footer: FOOTER, buttons: [reply("Book another time")],
    body: "Hi {{1}}, your {{2}} at Drevi on {{3}} at {{4}} has been cancelled. {{5}}\n\nTo book another time, just reply to this message." }),
  // ---- video calls (WhatsApp video or Google Meet) ----
  T({ name: "drevi_call_confirmed", title: "Video call confirmed", audience: "client", group: "call", vars: ["name", "what", "date", "time", "number", "how"],
    header: "Your video call is booked", footer: FOOTER, buttons: [reply("Need to reschedule")],
    body: "Hi {{1}}, your {{2}} with Drevi is confirmed.\n\n*Date:* {{3}}\n*Time:* {{4}}\n*Booking no.:* {{5}}\n\n*How to join:* {{6}}\n\nKeep any pictures or ideas you would like to show us handy. To change the time, just reply to this message." }),
  T({ name: "drevi_call_reminder_day", title: "Video call: reminder a day before", audience: "client", group: "call", vars: ["name", "what", "date", "time", "how"],
    header: "Your call is tomorrow", footer: FOOTER, buttons: [reply("I'll be there"), reply("Need to reschedule")],
    body: "Hi {{1}}, a reminder of your {{2}} with Drevi tomorrow.\n\n*Date:* {{3}}\n*Time:* {{4}}\n\n*How to join:* {{5}}\n\nTo change the time, just reply to this message." }),
  T({ name: "drevi_call_reminder_soon", title: "Video call: reminder 2 hours before", audience: "client", group: "call", vars: ["name", "what", "time", "how"],
    header: "Your call is today", footer: FOOTER, buttons: [reply("I'm ready"), reply("Running late")],
    body: "Hi {{1}}, your {{2}} with Drevi starts today at {{3}}.\n\n*How to join:* {{4}}\n\nPlease find a spot with good light and a steady connection. Running late? Just reply to this message." }),
  T({ name: "drevi_call_moved", title: "Video call moved", audience: "client", group: "call", vars: ["name", "what", "date", "time", "number", "how"],
    header: "Your call has moved", footer: FOOTER, buttons: [reply("Need another time")],
    body: "Hi {{1}}, your {{2}} with Drevi has been moved to a new time.\n\n*Date:* {{3}}\n*Time:* {{4}}\n*Booking no.:* {{5}}\n\n*How to join:* {{6}}\n\nIf the new time doesn't suit you, just reply to this message." }),
  T({ name: "drevi_call_cancelled", title: "Video call cancelled", audience: "client", group: "call", vars: ["name", "what", "date", "time", "reason"],
    header: "Video call cancelled", footer: FOOTER, buttons: [reply("Book another time")],
    body: "Hi {{1}}, your {{2}} with Drevi on {{3}} at {{4}} has been cancelled. {{5}}\n\nTo book another time, just reply to this message." }),
  // ---- the team ----
  T({ name: "drevi_staff_new_booking", title: "New booking (team)", audience: "staff", group: "staff", vars: ["source", "number", "kind", "when", "customer", "occasion", "looking"],
    header: "New appointment",
    body: `A new appointment has been booked via {{1}}.\n\n*Booking no.:* {{2}}\n*What:* {{3}}\n*When:* {{4}}\n*Customer:* {{5}}\n*Occasion:* {{6}}\n*Looking for:* {{7}}\n\n${PORTAL}` }),
  T({ name: "drevi_staff_changed", title: "Moved or cancelled (team)", audience: "staff", group: "staff", vars: ["number", "customer", "change", "by"],
    header: "Booking changed",
    body: `Booking {{1}} for {{2}} has been {{3}} by {{4}}.\n\n${PORTAL}` }),
  T({ name: "drevi_staff_today", title: "Today's appointments (team)", audience: "staff", group: "staff", vars: ["count", "list"],
    header: "Today's appointments",
    body: `Good morning. Appointments at Drevi today: {{1}}.\n\n{{2}}\n\n${PORTAL}` }),
  T({ name: "drevi_staff_heads_up", title: "Heads-up 30 minutes before (team)", audience: "staff", group: "staff", vars: ["customer", "time", "kind", "looking"],
    header: "Coming up in 30 minutes",
    body: "Your next appointment: {{1}} at {{2}}.\n\n*What:* {{3}}\n*Looking for:* {{4}}\n\nOpen Appointments in the Drevi portal for the notes." }),
  T({ name: "drevi_staff_needs_confirming", title: "Still needs confirming (team)", audience: "staff", group: "staff", vars: ["number", "customer", "kind", "when"],
    header: "Needs confirming",
    body: "Booking {{1}} for {{2}} is still waiting to be confirmed.\n\n*What:* {{3}}\n*When:* {{4}}\n\nPlease call or WhatsApp them, then confirm it in the Drevi portal." }),
]);
/** Example values Meta asks for when a template is submitted (made up; nothing is sent). */
export const TEMPLATE_SAMPLES: Record<string, string> = {
  name: "Ananya", what: "store visit", date: "Wednesday 18 November", time: "4 pm", number: "A-1043",
  how: "We will video call you on WhatsApp from this number, so please keep WhatsApp open.", reason: "We are sorry for any trouble.",
  kind: "Store visit (with family or friends)", source: "the website", when: "Wed 18 Nov at 4 pm", customer: "Ananya Mehta, +91 98765 43210",
  occasion: "Sangeet (mid-December)", looking: "A pastel lehenga for the sangeet", change: "moved to Thu 19 Nov at 3 pm", by: "the owner",
  count: "2", list: "1 pm store visit (Ananya), 4 pm video call (Kavya, not confirmed)",
};
export function sampleParams(t: Tpl): string[] {
  return t.vars.map((k) => (t.group === "call" && k === "what" ? "video shopping call" : TEMPLATE_SAMPLES[k] ?? k));
}
/** Which customer template a rule uses for this booking, decided by where it happens (store, or a call). */
const CLIENT_KIND: Record<string, string> = { "c-confirm": "confirmed", "c-24h": "reminder_day", "c-2h": "reminder_soon", "ev-moved": "moved", "ev-cancelled": "cancelled" };
export function templateFor(rule: string, a: Pick<Appt, "place">): string | null {
  const k = CLIENT_KIND[rule];
  return k ? `drevi_${a.place === "store" ? "visit" : "call"}_${k}` : null;
}
export function lintTemplate(t: Tpl): string[] {
  const issues: string[] = [], nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(nums)];
  if (uniq.length !== t.vars.length || uniq.some((n, i) => n !== i + 1)) issues.push(`variables ${uniq.join(",")} are not 1..${t.vars.length} in order`);
  if (/^\s*\{\{/.test(t.body)) issues.push("starts with a variable");
  if (/\}\}\s*$/.test(t.body)) issues.push("ends with a variable");
  if (/\}\}\s*\{\{/.test(t.body)) issues.push("two variables touch");
  if (t.body.length > 1024) issues.push("longer than 1024");
  if (!/^[a-z0-9_]{1,512}$/.test(t.name)) issues.push("name must be lowercase letters, digits and _");
  if (!t.header || t.header.length > 60 || /\{\{|\n|\*/.test(t.header)) issues.push("header must be plain text up to 60");
  if (t.footer && (t.footer.length > 60 || /\{\{/.test(t.footer))) issues.push("footer up to 60, no variables");
  const b = t.buttons ?? [];
  if (b.length > 10 || b.filter((x) => x.type === "url").length > 2) issues.push("too many buttons");
  if (b.some((x) => x.text.length > 25 || (x.type === "url" && !/^https:\/\//.test(x.url)))) issues.push("button text over 25 or url not https");
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
function howFor(a: Appt): string {
  return a.place === "wa" ? "We will video call you on WhatsApp from this number, so please keep WhatsApp open."
    : a.meet_link ? `Join on Google Meet at ${a.meet_link}`
    : "We will send you the Google Meet link in this chat before the call.";
}
const SOURCE_SPOKEN: Record<ApptSource, string> = { website: "the website", phone: "a phone call", whatsapp: "WhatsApp", instagram: "Instagram", walkin: "the shop", other: "another way" };
function kindFor(a: Appt, t: ApptType | null | undefined): string {
  const where = a.place === "store" ? (a.type_id === "store" ? "" : " at the store") : a.place === "wa" ? " on WhatsApp video" : " on Google Meet";
  return `${t?.name ?? "Appointment"}${where}${a.party === "group" ? " (with family or friends)" : ""}`;
}
export interface RenderCtx { types: ApptType[]; hostName?: string | null; byName?: string; change?: string; reason?: string; digest?: { count: number; list: string } }
/** Template variables in order, ready for AiSensy's templateParams. */
export function renderParams(tplName: string, a: Appt | null, ctx: RenderCtx): string[] {
  const tpl = TEMPLATES[tplName]; if (!tpl) throw new Error(`unknown template ${tplName}`);
  const t = a ? ctx.types.find((x) => x.id === a.type_id) : null, p = a ? istParts(a.starts_at) : null;
  const v: Record<string, string> = a && p ? {
    name: firstName(a.customer_name), customer: `${a.customer_name}, ${showPhone(a.phone_e164)}`,
    what: TYPE_SPOKEN[a.type_id] ?? (t?.name.toLowerCase() || "appointment"), kind: kindFor(a, t),
    date: dayLong(p.day), time: timeFor(a), when: `${dayShort(p.day)} at ${timeFor(a)}`, number: a.number, how: howFor(a),
    occasion: a.functions.length ? a.functions.join(", ") + (a.function_date ? ` (${a.function_date})` : "") : a.function_date || "not given",
    looking: a.looking_for || "not said", source: SOURCE_SPOKEN[a.source] ?? "another way",
    change: ctx.change || "changed", by: ctx.byName || "the team", reason: ctx.reason || "We are sorry for any trouble.",
  } : {};
  if (ctx.digest) { v.count = String(ctx.digest.count); v.list = ctx.digest.list; }
  return tpl.vars.map((k) => cleanParam(v[k], k === "looking" ? 200 : k === "list" ? 600 : 160));
}
/** The message as the customer reads it (header in bold, footer in italics, a link for the directions button). Also the text sent by hand. */
export function renderText(tplName: string, params: string[]): string {
  const t = TEMPLATES[tplName];
  const url = (t.buttons ?? []).find((b): b is Extract<TplButton, { type: "url" }> => b.type === "url");
  return `*${t.header}*\n\n` + t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? "")
    + (url ? `\n\n${url.text}: ${url.url}` : "") + (t.footer ? `\n\n_${t.footer}_` : "");
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
const ONCE = new Set(["s-new", "s-pending", "c-confirm"]);
export function planMessages(a: Appt, cfg: Config, opts: { actorStaffId?: string | null } = {}): PlannedMsg[] {
  const out: PlannedMsg[] = [], start = new Date(a.starts_at).getTime(), made = new Date(a.created_at).getTime(), H = 3600000, M = 60000;
  const people = cfg.people.filter((p) => p.active && p.wa_e164);
  const notActor = (p: Person) => !opts.actorStaffId || p.staff_id !== opts.actorStaffId;
  // One-off messages are keyed without their time: the times are planned from the server's clock but re-planned
  // from the row the database stored, a few milliseconds apart, and a new key would send them twice.
  const add = (m: Omit<PlannedMsg, "key">) => out.push({ ...m, key: ONCE.has(m.rule) ? `${m.rule}:${m.channel}:${m.to_address}` : `${m.rule}:${m.channel}:${m.to_address}:${m.due_at}` });
  // Staff: a new booking (not to the person who made it).
  for (const p of people.filter((x) => x.on_new && notActor(x)))
    add({ rule: "s-new", template: "drevi_staff_new_booking", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: iso(made), expires_at: iso(made + 2 * H) });
  if (!isLive(a.status)) return out;
  if (a.status === "requested") {
    for (const p of people.filter((x) => x.on_new))
      add({ rule: "s-pending", template: "drevi_staff_needs_confirming", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: iso(made + 2 * H), expires_at: iso(Math.min(start, made + 24 * H)) });
    return out; // the customer hears nothing until someone confirms
  }
  const confirmedAt = new Date(a.confirmed_at || a.created_at).getTime();
  if (a.notify_wa) {
    add({ rule: "c-confirm", template: templateFor("c-confirm", a)!, channel: "wa", audience: "client", recipient_name: a.customer_name, to_address: a.phone_e164, due_at: iso(confirmedAt), expires_at: iso(Math.min(start, confirmedAt + 6 * H)) });
    if (start - 24 * H > confirmedAt) add({ rule: "c-24h", template: templateFor("c-24h", a)!, channel: "wa", audience: "client", recipient_name: a.customer_name, to_address: a.phone_e164, due_at: iso(start - 24 * H), expires_at: iso(Math.min(start - 3 * H, fromIst(istParts(a.starts_at).day, 0).getTime())) });
    if (start - 2 * H > confirmedAt + 30 * M) add({ rule: "c-2h", template: templateFor("c-2h", a)!, channel: "wa", audience: "client", recipient_name: a.customer_name, to_address: a.phone_e164, due_at: iso(start - 2 * H), expires_at: iso(start - 15 * M) });
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
    add({ rule: ev.kind === "moved" ? "ev-moved" : "ev-cancelled", template: templateFor(ev.kind === "moved" ? "ev-moved" : "ev-cancelled", a)!, channel: "wa", audience: "client",
      recipient_name: a.customer_name, to_address: a.phone_e164, due_at: stamp, expires_at: iso(at + 6 * 3600000) });
  for (const p of people)
    add({ rule: "ev-staff", template: "drevi_staff_changed", channel: "wa", audience: "staff", recipient_name: p.name, to_address: p.wa_e164!, due_at: stamp, expires_at: iso(at + 3 * 3600000), params: { kind: ev.kind, by: ev.byName ?? "staff" } });
  return out;
}

/* ---------------- Send, tapped on a booking ---------------- */
/** A message that went to the test number in test mode: the customer never got it. */
export const wentToTest = (m: { state: string; reason: string | null }) => m.state === "sent" && /test mode/i.test(m.reason ?? "");
export type ManualWhat = "confirmation" | "reminder" | "moved" | "cancelled";
export const MANUAL_LABEL: Record<ManualWhat, string> = { confirmation: "confirmation", reminder: "reminder", moved: "new time", cancelled: "cancellation note" };
/** Which approved template a Send button uses for this booking now (by its rule), or why it cannot go. */
export function manualRule(what: ManualWhat, a: Pick<Appt, "status" | "starts_at" | "notify_wa">, now: Date): { rule: string } | { error: string } {
  if (!a.notify_wa) return { error: "WhatsApp messages are off for this customer." };
  const ahead = new Date(a.starts_at).getTime() - now.getTime();
  switch (what) {
    case "confirmation":
      if (a.status === "requested") return { error: "It still needs confirming: tap Confirm above first." };
      if (a.status !== "confirmed") return { error: "Only a confirmed booking gets the confirmation." };
      if (ahead <= 0) return { error: "The time has already passed." };
      return { rule: "c-confirm" };
    case "reminder": {
      if (a.status !== "confirmed") return { error: a.status === "requested" ? "It still needs confirming: tap Confirm above first." : "Only a confirmed booking gets a reminder." };
      if (ahead <= 0) return { error: "The time has already passed." };
      const days = dayDiff(istParts(now).day, istParts(a.starts_at).day);
      if (days === 0) return { rule: "c-2h" };
      if (days === 1) return { rule: "c-24h" };
      return { error: "A reminder can go the day before or on the day." };
    }
    case "moved":
      if (!isLive(a.status)) return { error: "Only a live booking can be sent its new time." };
      if (ahead <= 0) return { error: "The time has already passed." };
      return { rule: "ev-moved" };
    case "cancelled":
      if (a.status !== "cancelled") return { error: "The booking is not cancelled." };
      return { rule: "ev-cancelled" };
  }
}

/* ---------------- message text for previews (and the Meet link sent from the phone) ---------------- */
export function waLink(e164: string, text: string): string { return `https://wa.me/${waDigits(e164)}?text=${encodeURIComponent(text)}`; }
export function handText(rule: string, a: Appt, types: ApptType[], ctx: Partial<RenderCtx> = {}): string { const n = templateFor(rule, a)!; return renderText(n, renderParams(n, a, { types, ...ctx })); }
export function handConfirmText(a: Appt, types: ApptType[]): string { return handText("c-confirm", a, types); }
export function handReminderText(a: Appt, types: ApptType[], now: Date): string {
  const sameDay = istParts(a.starts_at).day === istParts(now).day;
  if (sameDay) return handText("c-2h", a, types);
  const tomorrow = dayDiff(istParts(now).day, istParts(a.starts_at).day) === 1;
  return tomorrow ? handText("c-24h", a, types) : handText("c-24h", a, types).replace(" tomorrow.", ".").replace("*See you tomorrow*", "*A reminder from Drevi*").replace("*Your call is tomorrow*", "*A reminder from Drevi*");
}
