import { describe, it, expect } from "vitest";
import { fromIst, type Appt, type Config } from "./core";
import { availabilityFor, bookedReply, campaignText, cleanCampaign, cleanText, networkKey, noLinks, parseWebBook, slotProblem, shopWhatsAppText, validDay, webType } from "./website";

const cfg: Config = {
  types: [
    { id: "store", name: "Store visit", short_name: "Store visit", minutes: 30, group_minutes: 45, buffer_minutes: 0, notice_hours: 1, window_days: 60, places: ["store"], active: true, sort: 1 },
    { id: "video", name: "Video call shopping", short_name: "Video call", minutes: 30, group_minutes: 45, buffer_minutes: 0, notice_hours: 2, window_days: 60, places: ["wa", "meet"], active: true, sort: 2 },
    { id: "design", name: "Custom design consultation", short_name: "Custom design", minutes: 45, group_minutes: 45, buffer_minutes: 15, notice_hours: 24, window_days: 60, places: ["store", "wa", "meet"], active: true, sort: 3 },
  ],
  hours: [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, opens: w === 0 ? "13:00" : "12:00", closes: w === 0 ? "19:00" : "20:00" })),
  closures: [{ day: "2026-12-02", opens: null, closes: null, note: "Closed" }, { day: "2026-12-03", opens: "15:00", closes: "20:00", note: "Late opening" }],
  blocks: [],
  settings: { stylists: 2, step_minutes: 30, website_confirm: "instant", automation_on: false, test_mode: true, test_numbers: [], digest_hour: 11, campaigns: {} },
  people: [
    { id: "p1", name: "Owner", staff_id: "u-owner", wa_e164: "+919000000001", email: null, on_new: true, on_change: true, on_digest: true, on_heads_up: true, active: true },
    { id: "p2", name: "Stylist A", staff_id: "u-a", wa_e164: "+919000000003", email: null, on_new: false, on_change: false, on_digest: true, on_heads_up: true, active: true },
    { id: "p3", name: "Shop phone", staff_id: null, wa_e164: "+919000000005", email: null, on_new: true, on_change: true, on_digest: false, on_heads_up: false, active: true },
  ],
};

const NOW = fromIst("2026-11-30", 11 * 60); // Mon 30 Nov, 11 am IST
const store = cfg.types[0];
let n = 0;
function appt(day: string, start: string, mins = 30, o: Partial<Appt> = {}): Appt {
  const [h, m] = start.split(":").map(Number), s = fromIst(day, h * 60 + m);
  n += 1;
  return { id: "w" + n, number: "A-" + (2000 + n), type_id: "store", place: "store", party: "solo", starts_at: s.toISOString(), ends_at: new Date(s.getTime() + mins * 60000).toISOString(),
    status: "confirmed", source: "website", customer_name: "Ananya Mehta", phone_e164: "+919876543210", email: null, functions: [], function_date: null, looking_for: null, staff_notes: null,
    meet_link: null, host_staff_id: null, notify_wa: true, notify_email: false, offers_ok: false, outcome: null, cancel_reason: null, manage_token: "t", created_by: null,
    created_at: NOW.toISOString(), confirmed_at: NOW.toISOString(), cancelled_at: null, updated_at: NOW.toISOString(), rev: 1, ...o };
}
const good = { type: "store", party: "solo", day: "2026-12-01", min: 13 * 60, name: "Ananya Mehta", phone: "98765 43210", idempotency_key: "abcdef123456", elapsed_ms: 25000 };

describe("website booking: reading the form", () => {
  it("accepts a normal booking and fills defaults", () => {
    const r = parseWebBook(good, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.phone).toBe("+919876543210"); expect(r.value.place).toBe("store"); expect(r.value.notifyWa).toBe(true); expect(r.value.offersOk).toBe(false); }
  });
  it("refuses the hidden field, a too-fast form, bad names and numbers", () => {
    expect(parseWebBook({ ...good, hp: "Acme" }, cfg).ok).toBe(false);
    expect(parseWebBook({ ...good, company: "Acme Pvt Ltd" }, cfg).ok).toBe(true); // autofill may fill "company": not the trap
    expect(parseWebBook({ ...good, elapsed_ms: undefined }, cfg).ok).toBe(false);
    expect(parseWebBook({ ...good, elapsed_ms: "30000" }, cfg).ok).toBe(false);
    expect(parseWebBook({ ...good, whatsapp_ok: "false" }, cfg).ok).toBe(false);
    expect(parseWebBook({ ...good, elapsed_ms: 400 }, cfg).ok).toBe(false);
    const n1 = parseWebBook({ ...good, name: "A" }, cfg); expect(!n1.ok && n1.code).toBe("name_required");
    const n2 = parseWebBook({ ...good, name: "visit www.spam.example" }, cfg); expect(!n2.ok && n2.code).toBe("name_required");
    const p1 = parseWebBook({ ...good, phone: "12345" }, cfg); expect(!p1.ok && p1.code).toBe("invalid_phone");
    const e1 = parseWebBook({ ...good, email: "not-an-email" }, cfg); expect(!e1.ok && e1.code).toBe("invalid_email");
    expect(parseWebBook({ ...good, day: "2026-02-30" }, cfg).ok).toBe(false);
    expect(parseWebBook({ ...good, min: "780" }, cfg).ok).toBe(false);
    expect(parseWebBook({ ...good, party: "crowd" }, cfg).ok).toBe(false);
    expect(parseWebBook(null, cfg).ok).toBe(false);
  });
  it("names: any script, but no web addresses", () => {
    for (const nm of ["Ananya Mehta", "Dr. R. D'Souza", "Dr.Mehta", "अनन्या मेहता", "Jean-Luc O'Neil"]) expect(parseWebBook({ ...good, name: nm }, cfg).ok).toBe(true);
    for (const nm of ["bit.ly/drevi-prize Claim", "win at prize.com", "Ana 123", "<b>x</b>"]) expect(parseWebBook({ ...good, name: nm }, cfg).ok).toBe(false);
    const r = parseWebBook({ ...good, looking_for: "like this https://x.example/a and shop.com/p please", function_date: "see www.spam.example" }, cfg);
    expect(r.ok && r.value.lookingFor).toBe("like this [link removed] and [link removed] please");
    expect(r.ok && r.value.functionDate).toBe("see [link removed]");
    expect(noLinks("pastel lehenga")).toBe("pastel lehenga");
  });
  it("short or odd foreign numbers are refused as invalid_phone, not a server error", () => {
    const a = parseWebBook({ ...good, country: "+1", phone: "234567" }, cfg); expect(!a.ok && a.code).toBe("invalid_phone");
    const b = parseWebBook({ ...good, country: "+0", phone: "9876543210" }, cfg); expect(b.ok && b.value.phone).toBe("+919876543210"); // a bad code falls back to India
  });
  it("one network: IPv4 as is, IPv6 by its /64", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("2401:4900:1c2a:5e10:a1b2:c3d4:e5f6:0789")).toBe("2401:4900:1c2a:5e10::/64");
    expect(networkKey("2401:4900:1c2a:5e10::1")).toBe(networkKey("2401:4900:1c2a:5e10:ffff::2"));
    expect(networkKey("2401:db8::1")).toBe("2401:db8:0:0::/64");
    expect(networkKey(null)).toBeNull();
  });
  it("takes numbers from abroad with a country code", () => {
    const r = parseWebBook({ ...good, country: "+44", phone: "07700 900123" }, cfg);
    expect(r.ok && r.value.phone).toBe("+447700900123");
  });
  it("keeps only known functions and clean text", () => {
    const r = parseWebBook({ ...good, functions: ["Sangeet", "Sangeet", "<script>"], looking_for: "pastel\u0000 lehenga\n for sangeet", name: "  Ananya\u200b  Mehta " }, cfg);
    expect(r.ok && r.value.functions).toEqual(["Sangeet"]);
    expect(r.ok && r.value.lookingFor).toBe("pastel lehenga for sangeet");
    expect(r.ok && r.value.name).toBe("Ananya Mehta");
  });
  it("a switched-off type or a wrong place is refused", () => {
    const off = { ...cfg, types: cfg.types.map((t) => (t.id === "store" ? { ...t, active: false } : t)) };
    const r = parseWebBook(good, off); expect(!r.ok && r.code).toBe("type_off");
    expect(webType(cfg, "store", "meet").ok).toBe(false);
    expect(webType(cfg, "video", undefined)).toMatchObject({ ok: true, place: "wa" });
  });
  it("cleans ad tags and drops anything else", () => {
    const c = cleanCampaign({ utm_source: "instagram", utm_campaign: "visit-nov", fbclid: "IwAR123", landing: "/pages/visit?x=1", referrer: "https://l.instagram.com/?u=abc", evil: "x", utm_term: "" });
    expect(c).toEqual({ utm_source: "instagram", utm_campaign: "visit-nov", fbclid: "IwAR123", landing: "/pages/visit?x=1", referrer: "l.instagram.com" });
    expect(cleanCampaign({ gclid: "Cj0KCQiA_x-y", fbclid: "<script>" })).toEqual({ gclid: "Cj0KCQiA_x-y", fbclid: true });
    expect(cleanCampaign({ fbclid: "a".repeat(501) })).toEqual({ fbclid: true }); // never a cut id
    expect(cleanCampaign({ landing: "https://evil.example" })).toBeNull();
    expect(campaignText(c)).toBe(" From instagram / visit-nov.");
    expect(campaignText({ fbclid: true })).toBe(" From a Meta ad.");
    expect(campaignText(null)).toBe("");
    expect(cleanText("a\u2028b", 10)).toBe("a b");
    expect(cleanText("abc\ud83d", 10)).toBe("abc");
    expect(cleanText("ab\ud83d\ude00", 3)).toBe("ab");
    expect(cleanText("ab\ud83d\ude00", 10)).toBe("ab\ud83d\ude00");
    expect(validDay("2026-11-31")).toBe(false);
  });
});

describe("website booking: which times it offers", () => {
  it("never offers a time inside the notice, and only from today on", () => {
    const [today] = availabilityFor(cfg, [], { type: store, place: "store", party: "solo", from: "2026-11-01", days: 1, now: NOW });
    expect(today.day).toBe("2026-11-30");
    expect(today.slots[0].time).toBe("12 pm"); // 11 am now + 1 h notice: 12 pm is exactly on the edge
    expect(today.slots.every((s) => s.min >= 12 * 60)).toBe(true);
  });
  it("marks full times and closed days, and stops at the booking window", () => {
    const busy = [appt("2026-12-01", "13:00"), appt("2026-12-01", "13:00")];
    const days = availabilityFor(cfg, busy, { type: store, place: "store", party: "solo", from: "2026-12-01", days: 3, now: NOW });
    expect(days[0].slots.find((s) => s.min === 13 * 60)?.free).toBe(false);
    expect(days[0].free).toBe(days[0].slots.length - 1);
    expect(days[1]).toMatchObject({ day: "2026-12-02", closed: true, slots: [] });
    expect(days[2]).toMatchObject({ day: "2026-12-03", note: "Late opening", hours: "3 pm to 8 pm" });
    const far = availabilityFor(cfg, [], { type: store, place: "store", party: "solo", from: "2027-01-27", days: 10, now: NOW });
    expect(far.map((d) => d.day).at(-1)).toBe("2027-01-29"); // 60 days from 30 Nov
  });
  it("counts blocked time", () => {
    const blocked = { ...cfg, blocks: [{ id: "b", starts_at: fromIst("2026-12-01", 18 * 60).toISOString(), ends_at: fromIst("2026-12-01", 19 * 60).toISOString(), takes: 99, note: null }] };
    const [d] = availabilityFor(blocked, [], { type: store, place: "store", party: "solo", from: "2026-12-01", days: 1, now: NOW });
    expect(d.slots.filter((s) => !s.free).map((s) => s.time)).toEqual(["6 pm", "6:30 pm"]);
  });
  it("explains why a time cannot be booked", () => {
    const code = (day: string, min: number, appts: Appt[] = []) => slotProblem(cfg, appts, { type: store, place: "store", party: "solo", day, min, now: NOW })?.code ?? null;
    expect(code("2026-12-01", 13 * 60)).toBeNull();
    expect(code("2026-11-30", 11 * 60 + 30)).toBe("outside_hours"); // before opening
    expect(slotProblem(cfg, [], { type: store, place: "store", party: "solo", day: "2026-11-30", min: 13 * 60, now: fromIst("2026-11-30", 12 * 60 + 30) })?.code).toBe("too_soon");
    expect(code("2026-11-29", 13 * 60)).toBe("too_soon");
    expect(code("2026-12-02", 13 * 60)).toBe("closed");
    expect(code("2026-12-01", 19 * 60 + 45)).toBe("outside_hours");
    expect(code("2026-12-01", 13 * 60 + 10)).toBe("outside_hours");
    expect(code("2027-02-15", 13 * 60)).toBe("too_far");
    expect(code("2026-12-01", 13 * 60, [appt("2026-12-01", "13:00"), appt("2026-12-01", "13:00")])).toBe("slot_taken");
    expect(code("2026-12-01", 13 * 60, [appt("2026-12-01", "13:00"), appt("2026-12-01", "13:00", 30, { status: "cancelled" })])).toBeNull();
  });
});

describe("website booking: the reply", () => {
  it("gives the visit, the address and a WhatsApp message to the shop", () => {
    const r = bookedReply({ number: "A-1043", status: "confirmed", replayed: false, type: store, place: "store", party: "group", day: "2026-12-01", min: 16 * 60, name: "Ananya Mehta", autoWhatsApp: false });
    expect(r).toMatchObject({ number: "A-1043", when: "Tuesday 1 December at 4 pm", duration_minutes: 45, auto_whatsapp: false });
    expect(r.address).toContain("Dadar West");
    expect(r.shop_whatsapp.link.startsWith("https://wa.me/918433659684?text=")).toBe(true);
    expect(r.starts_at).toBe("2026-12-01T10:30:00.000Z");
    expect(shopWhatsAppText({ number: "A-1", typeId: "store", day: "2026-12-01", min: 16 * 60, name: "Ananya Mehta", status: "requested" }))
      .toBe("Hi Drevi, I have booked a store visit for Tuesday 1 December at 4 pm (booking A-1). My name is Ananya. Please confirm.");
  });
});

describe("website booking: functions and Meta cookies", () => {
  it("takes the new function names and still the old one, and nothing else", () => {
    const r = parseWebBook({ ...good, functions: ["Engagement", "Mayra", "Garba", "Wedding day", "Reception", "Reception or wedding day", "Birthday"] }, cfg);
    expect(r.ok && r.value.functions).toEqual(["Engagement", "Mayra", "Garba", "Wedding day", "Reception", "Reception or wedding day"]);
  });
  it("passes on Meta's _fbp and _fbc cookies only in their own format", () => {
    const ok = parseWebBook({ ...good, fbp: "fb.1.1732100000000.1234567890", fbc: "fb.1.1732100000000.IwAR0abc_DEF-9" }, cfg);
    expect(ok.ok && [ok.value.fbp, ok.value.fbc]).toEqual(["fb.1.1732100000000.1234567890", "fb.1.1732100000000.IwAR0abc_DEF-9"]);
    const tail = parseWebBook({ ...good, fbp: "fb.1.1732100000000.1234567890.AQ", fbc: "fb.1.1732100000000.IwAR0abc.Bg1a2B3c" }, cfg);
    expect(tail.ok && [tail.value.fbp, tail.value.fbc]).toEqual(["fb.1.1732100000000.1234567890.AQ", "fb.1.1732100000000.IwAR0abc.Bg1a2B3c"]);
    const bad = parseWebBook({ ...good, fbp: "x", fbc: "fb.1.123.<b>" }, cfg);
    expect(bad.ok && [bad.value.fbp, bad.value.fbc]).toEqual([null, null]);
  });
});
