import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadConfig, APPT_COLS } from "./server";
import { addDays, dayDiff, dayShort, durOf, fromIst, hm, isLive, istParts, planMessages, type Appt, type ApptStatus, type Config, type Party, type Place } from "./core";
import { MAX_DAYS, availabilityFor, bookedReply, campaignText, networkKey, parseWebBook, slotProblem, validDay, webParty, webType, type WebErr } from "./website";

// The website booking box's server side: what /api/appointments/availability
// and /api/appointments/book run. A booking is one call to appt_book_web()
// (0112): the limits, the "already booked" checks and appt_book() itself (0111,
// the same function staff bookings use) run under one lock, so parallel taps
// cannot slip past a limit. The website only ever books free times.

const NOT_SET_UP: WebErr = { ok: false, status: 503, code: "not_set_up", error: "Online booking is not available right now. Message us on WhatsApp and we will fix a time with you." };
const LIMITS = {
  phone: 3,    // live website bookings ahead for one number
  client: 6,   // website bookings from one network (IPv4 address or IPv6 /64) in an hour
  all: 60,     // website bookings in an hour, everyone together
};

async function config(): Promise<Config | WebErr> {
  const c = await loadConfig();
  if (!c.ok) { if (!c.missing) console.error("[appointments-web] config:", c.error); return NOT_SET_UP; }
  return c.data;
}
async function liveBetween(fromIso: string, toIso: string): Promise<Appt[]> {
  const from = new Date(new Date(fromIso).getTime() - 6 * 3600000).toISOString(), to = new Date(new Date(toIso).getTime() + 6 * 3600000).toISOString();
  const { data, error } = await createAdminClient().from("appointments").select(APPT_COLS).gte("starts_at", from).lt("starts_at", to).in("status", ["requested", "confirmed", "arrived"]);
  if (error) throw new Error(error.message);
  return (data ?? []) as Appt[];
}

export async function websiteAvailability(q: URLSearchParams, now = new Date()) {
  const cfg = await config(); if ("ok" in cfg) return cfg;
  const t = webType(cfg, q.get("type") || "store", q.get("place")); if (!t.ok) return t;
  const party = webParty(q.get("party")); if (!party) return { ok: false as const, status: 400, code: "bad_request", error: "party is solo or group." };
  const today = istParts(now).day, lastDay = addDays(today, t.type.window_days);
  let from = validDay(q.get("from")) ? q.get("from")! : today;
  if (from < today) from = today;
  if (from > lastDay) from = lastDay;
  const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(q.get("days"))) || 14));
  const appts = await liveBetween(fromIst(from, 0).toISOString(), fromIst(addDays(from, days), 0).toISOString());
  const list = availabilityFor(cfg, appts, { type: t.type, place: t.place, party, from, days, now });
  return {
    ok: true as const, today, timezone: "Asia/Kolkata",
    type: { id: t.type.id, name: t.type.name, minutes: t.type.minutes, group_minutes: t.type.group_minutes, notice_hours: t.type.notice_hours, window_days: t.type.window_days, places: t.type.places },
    place: t.place, party, duration_minutes: durOf(t.type, party), last_day: addDays(today, t.type.window_days),
    confirm: cfg.settings.website_confirm === "staff" ? "staff" : "instant",
    days: list,
  };
}

/** One-way, salted: lets us count bookings from one network without keeping the address. */
function clientHash(ip: string | null): string | null {
  const key = networkKey(ip);
  if (!key) return null;
  const salt = process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "drevi-appointments";
  return createHash("sha256").update(`${salt}:${key}`).digest("hex").slice(0, 32);
}
const tooMany = (msg: string): WebErr => ({ ok: false, status: 429, code: "rate_limited", error: msg });
const LIMIT_TEXT: Record<string, string> = {
  rate_phone: "This number already has bookings coming up. Message us on WhatsApp to change one.",
  rate_client: "Too many bookings from here in the last hour. Please message us on WhatsApp instead.",
  rate_all: "Lots of people are booking right now. Please try again in a few minutes, or message us on WhatsApp.",
};

/** Whether the customer gets an automatic WhatsApp confirmation now (else the page offers the WhatsApp button). */
function autoWhatsApp(cfg: Config, notifyWa: boolean, status: string): boolean {
  const s = cfg.settings;
  return s.automation_on && !s.test_mode && notifyWa && status === "confirmed" && !!process.env.AISENSY_APPT_API_KEY?.trim() && !!s.campaigns?.drevi_appt_confirmed;
}

export async function websiteBook(body: unknown, ip: string | null, now = new Date()) {
  const cfg = await config(); if ("ok" in cfg) return cfg;
  const p = parseWebBook(body, cfg); if (!p.ok) return p;
  const v = p.value;
  // Out-of-range days are answered before anything reads the database.
  const ahead = dayDiff(istParts(now).day, v.day);
  if (ahead < 0 || ahead > v.type.window_days) return slotProblem(cfg, [], { type: v.type, place: v.place, party: v.party, day: v.day, min: v.min, now })!;

  const dayStart = fromIst(v.day, 0).toISOString(), dayEnd = fromIst(v.day, 1440).toISOString();
  const appts = await liveBetween(dayStart, dayEnd);
  const freshDay = (list: Appt[]) => availabilityFor(cfg, list, { type: v.type, place: v.place, party: v.party, from: v.day, days: 1, now })[0] ?? null;
  // Hours, notice and the booking window are checked here. A full time is left to the database: under its
  // lock it first recognises a second tap of a booking that has just taken the last place.
  const problem = slotProblem(cfg, appts, { type: v.type, place: v.place, party: v.party, day: v.day, min: v.min, now });
  if (problem && problem.code !== "slot_taken") return { ...problem, day: null };

  const status: ApptStatus = cfg.settings.website_confirm === "staff" ? "requested" : "confirmed";
  const startIso = fromIst(v.day, v.min).toISOString(), nowIso = now.toISOString();
  const end = new Date(new Date(startIso).getTime() + durOf(v.type, v.party) * 60000).toISOString();
  const draft: Appt = {
    id: "", number: "", type_id: v.type.id, place: v.place, party: v.party, starts_at: startIso, ends_at: end, status, source: "website",
    customer_name: v.name, phone_e164: v.phone, email: v.email, functions: v.functions, function_date: v.functionDate, looking_for: v.lookingFor, staff_notes: null,
    meet_link: null, host_staff_id: null, notify_wa: v.notifyWa, notify_email: false, offers_ok: v.offersOk, outcome: null, cancel_reason: null,
    manage_token: "", created_by: null, created_at: nowIso, confirmed_at: status === "confirmed" ? nowIso : null, cancelled_at: null, updated_at: nowIso, rev: 1,
  };
  // The form's key is tied to what it books: the same tap again returns the same booking; the same key with a
  // different time, number or kind of visit is a different booking.
  const key = v.idempotencyKey ? "web:" + createHash("sha256").update([v.idempotencyKey, v.phone, startIso, v.type.id, v.place, v.party].join("|")).digest("hex").slice(0, 40) : null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("appt_book_web", {
    p: {
      type_id: draft.type_id, place: draft.place, party: draft.party, starts_at: draft.starts_at, ends_at: draft.ends_at, status, source: "website",
      customer_name: draft.customer_name, phone_e164: draft.phone_e164, email: draft.email, functions: draft.functions, function_date: draft.function_date,
      looking_for: draft.looking_for, staff_notes: null, meet_link: null, host_staff_id: null, notify_wa: draft.notify_wa, notify_email: false, offers_ok: draft.offers_ok,
      override: false, idempotency_key: key, by_name: "Website", by_staff_id: null,
      event_text: `Booked on the website. ${v.type.name}, ${dayShort(v.day)} ${hm(v.min)}.${campaignText(v.campaign)}`,
      messages: planMessages(draft, cfg, { actorStaffId: null }),
    },
    p_hash: clientHash(ip), p_campaign: v.campaign, p_limits: LIMITS,
  });
  if (error) {
    console.error("[appointments-web] appt_book_web:", error.code, error.message);
    if (error.code === "PGRST202" || /appt_book_web/.test(error.message)) return NOT_SET_UP; // 0112 not applied yet
    return { ok: false as const, status: 500, code: "server_error", error: "Something went wrong on our side. Please try again, or message us on WhatsApp." };
  }
  const r = data as { ok: boolean; error?: string; id?: string; number?: string; replayed?: boolean };
  if (!r.ok) {
    if (r.error && LIMIT_TEXT[r.error]) return tooMany(LIMIT_TEXT[r.error]);
    if (r.error === "already_booked") return { ok: false as const, status: 409, code: "already_booked", error: "This number already has a booking at that time. Message us on WhatsApp if you'd like to change it." };
    if (r.error === "full" || r.error === "video_busy" || r.error === "host_busy") {
      return { ok: false as const, status: 409, code: "slot_taken", error: "Sorry, that time was just taken. Pick another time.", day: freshDay(await liveBetween(dayStart, dayEnd)) };
    }
    console.error("[appointments-web] appt_book_web refused:", r.error);
    return { ok: false as const, status: 409, code: "slot_taken", error: "That time cannot be booked. Pick another time.", day: freshDay(appts) };
  }
  if (r.replayed) {
    // Answer from what is stored, never from this request.
    const { data: row } = await admin.from("appointments").select("number, status, starts_at, type_id, place, party, notify_wa").eq("id", r.id!).maybeSingle();
    const st = row as { number: string; status: ApptStatus; starts_at: string; type_id: string; place: Place; party: Party; notify_wa: boolean } | null;
    const type = st ? cfg.types.find((t) => t.id === st.type_id) : null;
    if (!st || !type || !isLive(st.status)) return { ok: false as const, status: 409, code: "key_reused", error: "Please tap Book again." };
    const sp = istParts(st.starts_at);
    return bookedReply({ number: st.number, status: st.status, replayed: true, type, place: st.place, party: st.party, day: sp.day, min: sp.min, name: v.name, autoWhatsApp: autoWhatsApp(cfg, st.notify_wa, st.status) });
  }
  return bookedReply({ number: r.number!, status, replayed: false, type: v.type, place: v.place, party: v.party, day: v.day, min: v.min, name: v.name, autoWhatsApp: autoWhatsApp(cfg, v.notifyWa, status) });
}
