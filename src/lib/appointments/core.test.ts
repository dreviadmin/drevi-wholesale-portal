import { describe, it, expect } from "vitest";
import {
  TEMPLATES, lintTemplate, parsePhone, istParts, fromIst, slotsFor, conflictAt, planMessages, planEvent, renderParams, renderText,
  cleanParam, firstName, hoursFor, addDays, weekday, type Appt, type Config,
} from "./core";

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
const DAY = "2026-12-01"; // Tuesday
const NOW = fromIst("2026-11-30", 11 * 60);
let n = 0;
function appt(o: Partial<Appt> & { start: string; mins?: number; day?: string }): Appt {
  const [h, m] = o.start.split(":").map(Number), s = fromIst(o.day ?? DAY, h * 60 + m), e = new Date(s.getTime() + (o.mins ?? 30) * 60000);
  n += 1;
  return { id: "a" + n, number: "A-" + (1000 + n), type_id: "store", place: "store", party: "solo", starts_at: s.toISOString(), ends_at: e.toISOString(), status: "confirmed", source: "phone",
    customer_name: "Ananya Mehta", phone_e164: "+919876543210", email: null, functions: ["Sangeet"], function_date: "28 Nov", looking_for: "Pastel lehenga", staff_notes: null,
    meet_link: null, host_staff_id: null, notify_wa: true, notify_email: false, offers_ok: false, outcome: null, cancel_reason: null, manage_token: "tok", created_by: null,
    created_at: NOW.toISOString(), confirmed_at: NOW.toISOString(), cancelled_at: null, updated_at: NOW.toISOString(), rev: 1, ...o } as unknown as Appt;
}

describe("India time", () => {
  it("converts both ways without drift", () => {
    const d = fromIst("2026-11-14", 16 * 60 + 30);
    expect(d.toISOString()).toBe("2026-11-14T11:00:00.000Z");
    expect(istParts(d)).toEqual({ day: "2026-11-14", min: 990 });
    expect(istParts("2026-11-14T19:00:00Z")).toEqual({ day: "2026-11-15", min: 30 });
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(weekday("2026-11-15")).toBe(0);
  });
});

describe("opening hours", () => {
  it("uses closures before the weekly hours", () => {
    expect(hoursFor(cfg, "2026-12-02")).toEqual({ closed: true, note: "Closed" });
    expect(hoursFor(cfg, "2026-12-03")).toMatchObject({ open: 900, close: 1200, special: true });
    expect(hoursFor(cfg, "2026-11-15")).toEqual({ open: 780, close: 1140 });
  });
});

describe("slots and capacity (same rule as appt_conflict)", () => {
  it("two stylists: the third booking at the same time is refused", () => {
    const appts = [appt({ start: "13:00" }), appt({ start: "13:00" })];
    const c = conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 780), end: fromIst(DAY, 810), place: "store" });
    expect(c).toBe("full");
  });
  it("counts the busiest moment, not every overlap", () => {
    const appts = [appt({ start: "12:00" }), appt({ start: "12:30" })];
    expect(conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 735), end: fromIst(DAY, 765), place: "store" })).toBeNull();
  });
  it("a group visit uses its longer slot", () => {
    const appts = [appt({ start: "13:30", mins: 45, party: "group" }), appt({ start: "14:00" })];
    expect(conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 840), end: fromIst(DAY, 870), place: "store" })).toBe("full");
  });
  it("one video call at a time", () => {
    const appts = [appt({ start: "16:00", type_id: "video", place: "wa" })];
    expect(conflictAt(cfg, appts, { typeId: "video", start: fromIst(DAY, 960), end: fromIst(DAY, 990), place: "meet" })).toBe("video_busy");
    expect(conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 960), end: fromIst(DAY, 990), place: "store" })).toBeNull();
  });
  it("a stylist cannot take two at once", () => {
    const appts = [appt({ start: "15:00", host_staff_id: "u-a" })];
    expect(conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 900), end: fromIst(DAY, 930), place: "store", host: "u-a" })).toBe("host_busy");
  });
  it("a block takes a stylist; a whole-shop block takes all", () => {
    const c1 = { ...cfg, blocks: [{ id: "b", starts_at: fromIst(DAY, 720).toISOString(), ends_at: fromIst(DAY, 1200).toISOString(), takes: 1, note: "Stylist off" }] };
    expect(conflictAt(c1, [appt({ start: "13:00" })], { typeId: "store", start: fromIst(DAY, 780), end: fromIst(DAY, 810), place: "store" })).toBe("full");
    const c2 = { ...cfg, blocks: [{ id: "b", starts_at: fromIst(DAY, 720).toISOString(), ends_at: fromIst(DAY, 780).toISOString(), takes: 99, note: "Shop busy" }] };
    expect(conflictAt(c2, [], { typeId: "store", start: fromIst(DAY, 750), end: fromIst(DAY, 780), place: "store" })).toBe("full");
  });
  it("the gap after a custom design consultation blocks the next start", () => {
    const appts = [appt({ start: "13:00", mins: 45, type_id: "design" }), appt({ start: "13:00", mins: 45, type_id: "design" })];
    expect(conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 825), end: fromIst(DAY, 855), place: "store" })).toBe("full");
    expect(conflictAt(cfg, appts, { typeId: "store", start: fromIst(DAY, 840), end: fromIst(DAY, 870), place: "store" })).toBeNull();
  });
  it("lists slots inside hours, skips closed days, respects notice for the website", () => {
    const s = slotsFor(cfg, [], { typeId: "store", day: DAY, place: "store", party: "solo", now: NOW, staff: false });
    expect(s[0].min).toBe(720); expect(s[s.length - 1].min).toBe(19 * 60 + 30);
    expect(slotsFor(cfg, [], { typeId: "store", day: "2026-12-02", place: "store", party: "solo", now: NOW, staff: true })).toEqual([]);
    const sameDay = slotsFor(cfg, [], { typeId: "store", day: "2026-11-30", place: "store", party: "solo", now: NOW, staff: false });
    expect(sameDay[0].min).toBe(12 * 60); // 11:00 now + 1 hour notice
    const later = slotsFor(cfg, [], { typeId: "store", day: "2026-11-30", place: "store", party: "solo", now: fromIst("2026-11-30", 11 * 60 + 40), staff: false });
    expect(later[0].min).toBe(13 * 60); // 11:40 + 1 hour, rounded up to the next start
    const group = slotsFor(cfg, [], { typeId: "store", day: DAY, place: "store", party: "group", now: NOW, staff: false });
    expect(group[group.length - 1].min).toBe(19 * 60); // 45 minutes must end by 8 pm
  });
});

describe("phone numbers", () => {
  it.each([
    ["98765 43210", "+91", "+919876543210"], ["098765 43210", "+91", "+919876543210"], ["+91 98765 43210", "+91", "+919876543210"],
    ["919876543210", "+91", "+919876543210"], ["12345", "+91", null], ["022 2430 1234", "+91", null], ["50 123 4567", "+971", "+971501234567"],
    ["0501234567", "+971", "+971501234567"], ["(415) 555-0123", "+1", "+14155550123"], ["+971 50 123 4567", "+91", "+971501234567"],
  ])("%s with %s", (raw, cc, want) => { expect(parsePhone(raw, cc)).toBe(want); });
});

describe("templates", () => {
  it.each(Object.values(TEMPLATES).map((t) => [t.name, t]))("%s follows Meta's rules", (_name, t) => { expect(lintTemplate(t as never)).toEqual([]); });
  it("values are one line, capped and never empty", () => {
    expect(cleanParam("a\nb\t c    d")).toBe("a b c d");
    expect(cleanParam("")).toBe("not given");
    expect(cleanParam("x".repeat(300), 20)).toHaveLength(20);
  });
  it("first names skip titles", () => { expect(firstName("Mrs. Ananya Mehta")).toBe("Ananya"); expect(firstName("Dr Sana Qureshi")).toBe("Sana"); });
  it("fills the confirmation", () => {
    const a = appt({ start: "16:30" });
    const text = renderText("drevi_appt_confirmed", renderParams("drevi_appt_confirmed", a, { types: cfg.types }));
    expect(text).toContain("Hi Ananya, your store visit with Drevi is booked for Tuesday 1 December at 4:30 pm.");
    expect(text).toContain("Senapati Bapat Marg");
  });
  it("says India time to a number abroad", () => {
    const a = appt({ start: "16:30", phone_e164: "+971501234567", type_id: "video", place: "wa" });
    expect(renderParams("drevi_appt_confirmed", a, { types: cfg.types })[3]).toBe("4:30 pm India time");
  });
});

describe("message plan", () => {
  it("a confirmed booking: staff alert, confirmation, both reminders, heads-up", () => {
    const a = appt({ start: "16:00", day: "2026-12-05", host_staff_id: "u-a" });
    const plan = planMessages(a, cfg, { actorStaffId: "u-owner" });
    expect(plan.map((m) => m.rule).sort()).toEqual(["c-24h", "c-2h", "c-confirm", "s-heads-up", "s-new"]);
    expect(plan.filter((m) => m.rule === "s-new").map((m) => m.recipient_name)).toEqual(["Shop phone"]); // not the owner who booked it
    expect(plan.find((m) => m.rule === "s-heads-up")!.recipient_name).toBe("Stylist A");
  });
  it("booked less than a day ahead: no day-before reminder", () => {
    const a = appt({ start: "16:00", day: "2026-11-30" });
    expect(planMessages(a, cfg).some((m) => m.rule === "c-24h")).toBe(false);
  });
  it("no WhatsApp consent: nothing to the customer", () => {
    const a = appt({ start: "16:00", day: "2026-12-05", notify_wa: false });
    expect(planMessages(a, cfg).some((m) => m.audience === "client")).toBe(false);
  });
  it("pencilled in: no customer message, a nudge to staff", () => {
    const a = appt({ start: "16:00", day: "2026-12-05", status: "requested", confirmed_at: null });
    const plan = planMessages(a, cfg);
    expect(plan.some((m) => m.audience === "client")).toBe(false);
    expect(plan.filter((m) => m.rule === "s-pending")).toHaveLength(2);
  });
  it("cancelled: only the original staff alert remains planned", () => {
    const a = appt({ start: "16:00", day: "2026-12-05", status: "cancelled" });
    expect(planMessages(a, cfg).map((m) => m.rule)).toEqual(["s-new", "s-new"]);
  });
  it("keys are stable for the same state (so a replan revives, never duplicates)", () => {
    const a = appt({ start: "16:00", day: "2026-12-05" });
    expect(planMessages(a, cfg).map((m) => m.key)).toEqual(planMessages({ ...a }, cfg).map((m) => m.key));
  });
  it("an event tells the customer and the change list, not the person who made it", () => {
    const a = appt({ start: "16:00", day: "2026-12-05" });
    const ev = planEvent(a, cfg, { kind: "moved", at: NOW, actorStaffId: "u-owner", tellClient: true });
    expect(ev.map((m) => `${m.rule}:${m.recipient_name}`)).toEqual(["ev-moved:Ananya Mehta", "ev-staff:Shop phone"]);
    expect(ev.every((m) => m.rule.startsWith("ev-"))).toBe(true);
  });
});
