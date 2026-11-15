// Website booking box (drevifashion.com) — the pure part: reading what the
// visitor sent, which times the website may offer, and the words that go
// back. No database here, so all of it is unit-tested (website.test.ts).
// The routes are /api/appointments/availability and /api/appointments/book;
// docs/WEBSITE-BOOKING-API.md is the contract the theme is built against.
//
// The website is stricter than staff: it only offers times that are free,
// inside opening hours, at least the type's notice ahead and within its
// booking window, and only for types switched on. Staff can still book
// anything from the portal.

import {
  FUNCTIONS, SHOP_ADDRESS, TYPE_SPOKEN, addDays, dayDiff, dayLong, dayShort, durOf, firstName, fromIst, hm, hoursFor, istParts, parsePhone, slotsFor, waLink,
  type Appt, type ApptType, type Config, type Party, type Place,
} from "./core";

/** The shop's customer WhatsApp (the number on /pages/visit). */
export const SHOP_WA = "+918433659684";
export const MAX_DAYS = 31;

export type WebErr = { ok: false; status: number; code: string; error: string };
const err = (status: number, code: string, error: string): WebErr => ({ ok: false, status, code, error });
const FALLBACK = "Message us on WhatsApp and we will fix a time with you.";

// Control characters, zero-width marks and the two Unicode line separators.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029]", "g");
/** Strip control characters and squeeze spaces; cap the length. */
export function cleanText(v: unknown, max: number): string {
  // The cap can cut an emoji in half; a lone half (or one sent on purpose) is dropped, as the database refuses it.
  return String(v ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max).replace(/\p{Cs}/gu, "").trim();
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validDay(d: unknown): d is string {
  if (typeof d !== "string" || !DAY_RE.test(d)) return false;
  const [y, m, dd] = d.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, dd));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === dd;
}

/** A type the website may book: switched on, and a place it happens. */
export function webType(cfg: Config, typeId: unknown, place: unknown): { ok: true; type: ApptType; place: Place } | WebErr {
  const type = cfg.types.find((t) => t.id === typeId && t.active);
  if (!type) return err(404, "type_off", `Online booking for this is closed right now. ${FALLBACK}`);
  const p = (place == null || place === "" ? type.places[0] : place) as Place;
  if (!type.places.includes(p)) return err(400, "bad_request", "That kind of appointment does not happen there.");
  return { ok: true, type, place: p };
}
export const webParty = (v: unknown): Party | null => (v == null || v === "" || v === "solo" ? "solo" : v === "group" ? "group" : null);

/* ---------------- availability ---------------- */
export interface WebDay {
  day: string; label: string; long: string; closed: boolean; note: string | null; hours: string | null;
  slots: Array<{ min: number; time: string; free: boolean }>; free: number;
}
/** The days from `from` (clamped to today .. the booking window), with the times the website may offer. */
export function availabilityFor(cfg: Config, appts: Appt[], o: { type: ApptType; place: Place; party: Party; from: string; days: number; now: Date }): WebDay[] {
  const today = istParts(o.now).day, last = addDays(today, o.type.window_days);
  const first = o.from < today ? today : o.from;
  const out: WebDay[] = [];
  for (let i = 0; i < Math.min(Math.max(1, o.days), MAX_DAYS); i++) {
    const day = addDays(first, i);
    if (day > last) break;
    const h = hoursFor(cfg, day), closed = "closed" in h;
    const slots = closed ? [] : slotsFor(cfg, appts, { typeId: o.type.id, day, place: o.place, party: o.party, now: o.now, staff: false })
      .map((s) => ({ min: s.min, time: hm(s.min), free: s.free }));
    out.push({
      day, label: dayShort(day), long: dayLong(day), closed, note: h.note ?? null,
      hours: closed ? null : `${hm((h as { open: number }).open)} to ${hm((h as { close: number }).close)}`,
      slots, free: slots.filter((s) => s.free).length,
    });
  }
  return out;
}

/** Why the website cannot book `min` on `day`, or null when it can. */
export function slotProblem(cfg: Config, appts: Appt[], o: { type: ApptType; place: Place; party: Party; day: string; min: number; now: Date }): WebErr | null {
  const today = istParts(o.now).day, ahead = dayDiff(today, o.day);
  if (ahead < 0) return err(409, "too_soon", "That day has passed. Pick another day.");
  if (ahead > o.type.window_days) return err(409, "too_far", `Online booking is open up to ${o.type.window_days} days ahead. Pick an earlier day, or ${FALLBACK.charAt(0).toLowerCase()}${FALLBACK.slice(1)}`);
  const h = hoursFor(cfg, o.day);
  if ("closed" in h) return err(409, "closed", `We are closed on ${dayShort(o.day)}${h.note ? ` (${h.note})` : ""}. Pick another day.`);
  const dur = durOf(o.type, o.party);
  if (!Number.isInteger(o.min) || o.min < h.open || o.min + dur > h.close) return err(409, "outside_hours", `That time is outside our hours on ${dayShort(o.day)} (${hm(h.open)} to ${hm(h.close)}). Pick another time.`);
  const lead = (fromIst(o.day, o.min).getTime() - o.now.getTime()) / 60000;
  if (lead < o.type.notice_hours * 60) return err(409, "too_soon", `That time is too soon to book online. Pick a time at least ${o.type.notice_hours} hour${o.type.notice_hours === 1 ? "" : "s"} from now, or ${FALLBACK.charAt(0).toLowerCase()}${FALLBACK.slice(1)}`);
  const s = slotsFor(cfg, appts, { typeId: o.type.id, day: o.day, place: o.place, party: o.party, now: o.now, staff: false }).find((x) => x.min === o.min);
  if (!s) return err(409, "outside_hours", "That is not one of our start times. Pick a time from the list.");
  if (!s.free) return err(409, "slot_taken", "Sorry, that time was just taken. Pick another time.");
  return null;
}

/* ---------------- the booking form ---------------- */
export interface WebCampaign { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_content?: string; utm_term?: string; fbclid?: boolean; gclid?: boolean; landing?: string; referrer?: string }
export interface WebBook {
  type: ApptType; place: Place; party: Party; day: string; min: number;
  name: string; phone: string; email: string | null; functions: string[]; functionDate: string | null; lookingFor: string | null;
  notifyWa: boolean; offersOk: boolean; idempotencyKey: string | null; campaign: WebCampaign | null;
}

/** Only these tags, short and plain. Anything else the page sends is dropped. */
export function cleanCampaign(v: unknown): WebCampaign | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>, c: WebCampaign = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const) { const t = cleanText(o[k], 100); if (t) c[k] = t; }
  if (o.fbclid) c.fbclid = true;
  if (o.gclid) c.gclid = true;
  const landing = cleanText(o.landing, 200); if (landing.startsWith("/")) c.landing = landing;
  const ref = cleanText(o.referrer, 300);
  if (ref) { try { c.referrer = new URL(ref).hostname.slice(0, 100); } catch { /* not a URL: dropped */ } }
  return Object.keys(c).length ? c : null;
}
/** "from instagram / diwali-visit", for the booking's history line. */
export function campaignText(c: WebCampaign | null): string {
  if (!c) return "";
  const src = c.utm_source || (c.fbclid ? "a Meta ad" : c.gclid ? "a Google ad" : c.referrer || "");
  const bits = [src, c.utm_campaign, c.utm_content].filter(Boolean);
  return bits.length ? ` From ${bits.join(" / ")}.` : "";
}

// A name: letters (any script), spaces and . ' - only, and nothing that looks like a web address.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,79}$/u;
const DOMAIN_RE = /[\p{L}\d-]\.(com|in|co|net|org|io|ly|me|app|link|xyz|site|online|shop|info|biz|top|click|live|store)\b/iu;
const LINKISH = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|in|co|net|org|io|ly|me|app|link|xyz|site|online|shop|info|biz|top|click|live|store)(\/\S*)?/gi;
/** Free text that goes into staff alerts: web addresses are replaced, so the shop's WhatsApp never carries a stranger's link. */
export function noLinks(t: string): string { return t.replace(LINKISH, "[link removed]"); }

export function parseWebBook(body: unknown, cfg: Config): { ok: true; value: WebBook } | WebErr {
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "bad_request", "Please try again.");
  const b = body as Record<string, unknown>;
  // A field people never see ("hp"). Bots fill it; real visitors leave it empty.
  if (cleanText(b.hp, 200)) { console.warn("[appointments-web] trap field filled"); return err(400, "bad_request", "Please try again."); }
  // How long the form was open. A person takes more than 2 seconds.
  if (typeof b.elapsed_ms !== "number" || !Number.isFinite(b.elapsed_ms) || b.elapsed_ms < 2000) return err(400, "bad_request", "Please check your details and tap Book again.");
  if ((b.whatsapp_ok !== undefined && typeof b.whatsapp_ok !== "boolean") || (b.offers_ok !== undefined && typeof b.offers_ok !== "boolean")) return err(400, "bad_request", "Please try again.");
  const t = webType(cfg, b.type ?? "store", b.place); if (!t.ok) return t;
  const party = webParty(b.party); if (!party) return err(400, "bad_request", "Please say who is coming.");
  if (!validDay(b.day)) return err(400, "bad_request", "Pick a day.");
  const min = typeof b.min === "number" ? b.min : Number.NaN;
  if (!Number.isInteger(min) || min < 0 || min >= 1440) return err(400, "bad_request", "Pick a time.");
  const name = cleanText(b.name, 80);
  if (name.length < 2) return err(400, "name_required", "Please enter your name.");
  if (!NAME_RE.test(name) || DOMAIN_RE.test(name) || /www\./i.test(name)) return err(400, "name_required", "Please enter just your name.");
  const country = typeof b.country === "string" && /^\+[1-9]\d{0,3}$/.test(b.country) ? b.country : "+91";
  const phone = parsePhone(cleanText(b.phone, 30), country);
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) return err(400, "invalid_phone", country === "+91" ? "Please enter a 10-digit mobile number for WhatsApp." : "Please check your WhatsApp number and country code.");
  const email = cleanText(b.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return err(400, "invalid_email", "That email does not look right. You can leave it empty.");
  const functions = Array.isArray(b.functions) ? [...new Set(b.functions.filter((f): f is string => typeof f === "string" && FUNCTIONS.includes(f)))] : [];
  const key = typeof b.idempotency_key === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(b.idempotency_key) ? b.idempotency_key : null;
  return { ok: true, value: {
    type: t.type, place: t.place, party, day: b.day, min, name, phone, email: email || null, functions,
    functionDate: noLinks(cleanText(b.function_date, 60)) || null, lookingFor: noLinks(cleanText(b.looking_for, 600)) || null,
    notifyWa: b.whatsapp_ok !== false, offersOk: b.offers_ok === true, idempotencyKey: key, campaign: cleanCampaign(b.campaign),
  } };
}

/** The network a visitor books from: IPv4 as is; IPv6 by its /64 (one household or phone), so rotating addresses inside it count as one. */
export function networkKey(ip: string | null): string | null {
  if (!ip) return null;
  let a = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (a.startsWith("::ffff:") && a.includes(".")) a = a.slice(7);
  if (!a.includes(":")) return a;
  const [l, r = ""] = a.split("::");
  const left = l ? l.split(":") : [], right = a.includes("::") ? (r ? r.split(":") : []) : [];
  const groups = a.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/* ---------------- what goes back ---------------- */
/** The message the visitor can send the shop on WhatsApp after booking (it reaches the team straight away). */
export function shopWhatsAppText(o: { number: string; typeId: string; day: string; min: number; name: string; status: string }): string {
  const what = TYPE_SPOKEN[o.typeId] ?? "appointment";
  return `Hi Drevi, I have booked a ${what} for ${dayLong(o.day)} at ${hm(o.min)} (booking ${o.number}). My name is ${firstName(o.name)}.${o.status === "requested" ? " Please confirm." : ""}`;
}
export function bookedReply(o: { number: string; status: string; replayed: boolean; type: ApptType; place: Place; party: Party; day: string; min: number; name: string; autoWhatsApp: boolean }) {
  const start = fromIst(o.day, o.min), dur = durOf(o.type, o.party);
  const text = shopWhatsAppText({ number: o.number, typeId: o.type.id, day: o.day, min: o.min, name: o.name, status: o.status });
  return {
    ok: true as const, number: o.number, status: o.status, replayed: o.replayed,
    type: { id: o.type.id, name: o.type.name }, place: o.place, party: o.party,
    day: o.day, min: o.min, time: hm(o.min), when: `${dayLong(o.day)} at ${hm(o.min)}`,
    starts_at: start.toISOString(), ends_at: new Date(start.getTime() + dur * 60000).toISOString(), duration_minutes: dur,
    address: o.place === "store" ? SHOP_ADDRESS : null,
    auto_whatsapp: o.autoWhatsApp,
    shop_whatsapp: { number: SHOP_WA, text, link: waLink(SHOP_WA, text) },
  };
}
