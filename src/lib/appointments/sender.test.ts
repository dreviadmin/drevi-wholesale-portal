/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory database stands in for Supabase's untyped query builder */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Appt, Config } from "./core";

// sendManual (the booking page's Send buttons): which message row it goes
// through, when it refuses, and where it really sends. Supabase is replaced by
// a small in-memory database that honours each query's filters (the same fake
// as src/app/admin/orders-billing.test.ts), and AiSensy by a spy.

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let nextId = 0;
function fakeAdmin() {
  return {
    from(table: string) {
      let op: "select" | "update" | "insert" = "select";
      let payload: any;
      let returning = false;
      let one: "maybe" | "single" | null = null;
      let sort: { key: string; asc: boolean } | null = null;
      let lim: number | null = null;
      const tests: ((r: Row) => boolean)[] = [];
      const b: any = {
        select() { if (op !== "select") returning = true; return b; },
        update(p: Row) { op = "update"; payload = p; return b; },
        insert(p: Row) { op = "insert"; payload = p; return b; },
        eq(k: string, v: unknown) { tests.push((r) => r[k] === v); return b; },
        in(k: string, vs: unknown[]) { tests.push((r) => vs.includes(r[k])); return b; },
        order(k: string, o?: { ascending?: boolean }) { sort = { key: k, asc: o?.ascending !== false }; return b; },
        limit(n: number) { lim = n; return b; },
        maybeSingle() { one = "maybe"; return b; },
        single() { one = "single"; return b; },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(run).then(res, rej); },
      };
      const rows = () => (db[table] ??= []);
      const match = () => rows().filter((r) => tests.every((t) => t(r)));
      const shape = (list: Row[]) => {
        const copy = structuredClone(list);
        if (one) return { data: copy[0] ?? null, error: one === "single" && !copy[0] ? { message: "no rows" } : null };
        return { data: copy, error: null };
      };
      function run() {
        if (op === "select") {
          let list = match();
          if (sort) { const { key, asc } = sort; list = [...list].sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : 0) * (asc ? 1 : -1)); }
          if (lim != null) list = list.slice(0, lim);
          return shape(list);
        }
        if (op === "update") {
          const hit = match();
          for (const r of hit) Object.assign(r, structuredClone(payload));
          return returning ? shape(hit) : { data: null, error: null };
        }
        const list = [{ id: `${table}-${++nextId}`, ...structuredClone(payload) }];
        rows().push(...list);
        return returning ? shape(list) : { data: null, error: null };
      }
      return b;
    },
  };
}

const sendTemplateMessage = vi.fn(async (o: { destination: string; campaignName: string }) => { void o; return { sent: true } as { sent: boolean; uncertain?: boolean; error?: string }; });
let prodBlocker: string | null = null;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/aisensy", () => ({ sendTemplateMessage: (o: any) => sendTemplateMessage(o) }));
vi.mock("@/lib/wallet-core", () => ({ orderTagBlocker: () => prodBlocker }));
vi.mock("./server", () => ({ loadConfig: async () => ({ ok: false, missing: true, error: "not used here" }), APPT_COLS: "*" }));

const { sendManual } = await import("./sender");

const cfg = (o: Partial<Config["settings"]> = {}): Config => ({
  types: [{ id: "store", name: "Store visit", short_name: "Store visit", minutes: 30, group_minutes: 45, buffer_minutes: 0, notice_hours: 1, window_days: 60, places: ["store"], active: true, sort: 1 }],
  hours: [], closures: [], blocks: [], people: [],
  settings: { stylists: 2, step_minutes: 30, website_confirm: "instant", automation_on: true, test_mode: false, test_numbers: ["+919000001099"], digest_hour: 11, campaigns: {}, ...o },
});
const A: Appt = {
  id: "appt-1", number: "A-2001", type_id: "store", place: "store", party: "solo", starts_at: "2030-01-10T08:30:00.000Z", ends_at: "2030-01-10T09:00:00.000Z", status: "confirmed",
  source: "website", customer_name: "ZZ Test Customer", phone_e164: "+919000001011", email: null, functions: [], function_date: null, looking_for: null, staff_notes: null,
  meet_link: null, host_staff_id: null, notify_wa: true, notify_email: false, offers_ok: false, outcome: null, cancel_reason: null, manage_token: "t", created_by: null,
  created_at: "2030-01-01T00:00:00.000Z", confirmed_at: "2030-01-01T00:00:00.000Z", cancelled_at: null, updated_at: "2030-01-01T00:00:00.000Z", rev: 1,
};
const msg = (o: Row): Row => ({ id: `m-${++nextId}`, appointment_id: A.id, rule: "c-confirm", template: "drevi_visit_confirmed", audience: "client", recipient_name: A.customer_name,
  to_address: A.phone_e164, params: {}, due_at: "2030-01-01T00:00:00.000Z", state: "scheduled", created_at: "2030-01-01T00:00:00.000Z", sent_at: null, ...o });
const msgs = () => db.appointment_messages ?? [];

beforeEach(() => {
  db = { appointment_messages: [] }; nextId = 0; prodBlocker = null;
  sendTemplateMessage.mockClear();
  sendTemplateMessage.mockImplementation(async () => ({ sent: true }));
  process.env.AISENSY_APPT_API_KEY = "test-key";
});

describe("sendManual", () => {
  it("sends through the waiting confirmation, so the automatic one does not repeat it", async () => {
    db.appointment_messages.push(msg({ state: "scheduled" }));
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: false });
    expect(r).toEqual({ ok: true, to: "+919000001011", test: false });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage.mock.calls[0][0]).toMatchObject({ destination: "+919000001011", campaignName: "drevi_visit_confirmed" });
    expect(msgs()).toHaveLength(1);
    expect(msgs()[0]).toMatchObject({ state: "sent", reason: "Sent by Rakesh" });
  });

  it("in test mode it goes to the first test number, never the customer", async () => {
    const r = await sendManual({ cfg: cfg({ test_mode: true }), appt: A, rule: "c-24h", byName: "Rakesh", again: false });
    expect(r).toEqual({ ok: true, to: "+919000001099", test: true });
    expect(sendTemplateMessage.mock.calls[0][0].destination).toBe("+919000001099");
    expect(msgs()[0]).toMatchObject({ rule: "c-24h", template: "drevi_visit_reminder_day", state: "sent" });
    expect(msgs()[0].reason).toMatch(/test mode: to \+919000001099/);
  });

  it("asks before sending one that already went, then sends a second on again", async () => {
    db.appointment_messages.push(msg({ state: "sent", sent_at: "2030-01-01T00:01:00.000Z" }));
    const first = await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: false });
    expect(first).toMatchObject({ ok: false, again: true });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    const second = await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: true });
    expect(second.ok).toBe(true);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(msgs()).toHaveLength(2);
    expect(msgs().filter((m) => m.state === "sent")).toHaveLength(2);
  });

  it("refuses while another send of it is in flight", async () => {
    db.appointment_messages.push(msg({ state: "sending" }));
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: true });
    expect(r.ok).toBe(false);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("refuses without touching the queue when there is no AiSensy key, or outside production to a real number", async () => {
    db.appointment_messages.push(msg({ state: "scheduled" }));
    delete process.env.AISENSY_APPT_API_KEY; delete process.env.AISENSY_API_KEY;
    expect((await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: false })).ok).toBe(false);
    process.env.AISENSY_APPT_API_KEY = "test-key";
    prodBlocker = "not production";
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: false });
    expect(r).toMatchObject({ ok: false });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(msgs()[0].state).toBe("scheduled");
  });

  it("a send AiSensy refuses is kept as failed, with its error, and reported", async () => {
    sendTemplateMessage.mockImplementation(async () => ({ sent: false, error: "HTTP 400 campaign not found" }));
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "ev-cancelled", byName: "Rakesh", again: false });
    expect(r.ok).toBe(false);
    expect(msgs()[0]).toMatchObject({ rule: "ev-cancelled", state: "failed", last_error: "HTTP 400 campaign not found" });
  });

  it("in test mode it leaves the customer's waiting message alone and makes its own row", async () => {
    db.appointment_messages.push(msg({ state: "scheduled" }));
    const r = await sendManual({ cfg: cfg({ test_mode: true }), appt: A, rule: "c-confirm", byName: "Rakesh", again: false });
    expect(r).toMatchObject({ ok: true, test: true });
    expect(msgs()[0].state).toBe("scheduled");
    expect(msgs()[1]).toMatchObject({ state: "sent" });
  });

  it("a confirmation that only went to the test number does not count as sent to the customer", async () => {
    db.appointment_messages.push(msg({ state: "sent", reason: "Test mode: sent to +919000001099", sent_at: "2030-01-01T00:01:00.000Z" }));
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "c-confirm", byName: "Rakesh", again: false });
    expect(r.ok).toBe(true);
    expect(sendTemplateMessage.mock.calls[0][0].destination).toBe("+919000001011");
  });

  it("if the send does not go, the waiting message goes back to waiting, so the automatic send still happens", async () => {
    db.appointment_messages.push(msg({ rule: "c-2h", template: "drevi_visit_reminder_soon", state: "scheduled", due_at: "2030-01-10T06:30:00.000Z" }));
    sendTemplateMessage.mockImplementation(async () => ({ sent: false, error: "HTTP 400 campaign not found" }));
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "c-2h", byName: "Rakesh", again: false });
    expect(r.ok).toBe(false);
    expect(msgs()[0]).toMatchObject({ state: "scheduled", last_error: "HTTP 400 campaign not found", due_at: "2030-01-10T06:30:00.000Z" });
  });

  it("after a send, anything else of that kind still waiting is withdrawn, so it does not go twice", async () => {
    db.appointment_messages.push(msg({ rule: "ev-moved", template: "drevi_visit_moved", state: "scheduled", created_at: "2030-01-01T00:00:00.000Z" }));
    db.appointment_messages.push(msg({ rule: "ev-moved", template: "drevi_visit_moved", state: "scheduled", created_at: "2030-01-02T00:00:00.000Z" }));
    const r = await sendManual({ cfg: cfg(), appt: A, rule: "ev-moved", byName: "Rakesh", again: false });
    expect(r.ok).toBe(true);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(msgs().map((m) => m.state).sort()).toEqual(["cancelled", "sent"]);
  });
});
