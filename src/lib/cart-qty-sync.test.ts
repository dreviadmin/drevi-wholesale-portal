import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartQtySync, CART_SAVE_DELAY_MS } from "./cart-qty-sync";

// A save the test resolves by hand, so it can tap while one is in flight.
type Pending = { sku: string; qty: number; resolve: (stored: number) => void; reject: (e: unknown) => void };

function harness(delayMs = CART_SAVE_DELAY_MS) {
  const pending: Pending[] = [];
  const sent: [string, number][] = [];
  const serverQty: [string, number][] = [];
  const errors: [string | null, unknown][] = [];
  const busy: boolean[] = [];
  const idles: boolean[] = [];
  // Every callback in the order it came, for "before Submit is back" checks.
  const log: string[] = [];
  let idle = 0;
  const sync = new CartQtySync({
    delayMs,
    save: (sku, qty) => {
      sent.push([sku, qty]);
      return new Promise<number>((resolve, reject) => pending.push({ sku, qty, resolve, reject }));
    },
    onServerQty: (sku, qty) => { serverQty.push([sku, qty]); log.push(`show ${sku}=${qty}`); },
    onError: (sku, err) => { errors.push([sku, err]); log.push(`error ${sku}`); },
    onIdle: (failed) => { idle++; idles.push(failed); log.push(`idle ${failed}`); },
    onBusyChange: (b) => { busy.push(b); log.push(`busy ${b}`); },
  });
  // Resolve the oldest save still running, then let the queue move on.
  const reply = async (stored?: number) => {
    const p = pending.shift();
    if (!p) throw new Error("no save in flight");
    p.resolve(stored ?? p.qty);
    await vi.advanceTimersByTimeAsync(0);
  };
  const fail = async (err: unknown) => {
    const p = pending.shift();
    if (!p) throw new Error("no save in flight");
    p.reject(err);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { sync, pending, sent, serverQty, errors, busy, idles, log, reply, fail, idle: () => idle };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("CartQtySync", () => {
  it("sends one save with the last number after quick taps", async () => {
    const h = harness();
    h.sync.set("A", 6);
    await vi.advanceTimersByTimeAsync(100);
    h.sync.set("A", 7);
    await vi.advanceTimersByTimeAsync(100);
    h.sync.set("A", 8);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    expect(h.sent).toEqual([["A", 8]]);
    await h.reply();
    expect(h.sent).toEqual([["A", 8]]);
    expect(h.idle()).toBe(1);
  });

  it("waits for the taps to stop: each tap restarts the pause", async () => {
    const h = harness();
    h.sync.set("A", 2);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS - 50);
    h.sync.set("A", 3);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS - 50);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.sent).toEqual([["A", 3]]);
  });

  it("never lets a reply put back an older number over a newer tap", async () => {
    const h = harness();
    h.sync.set("A", 3);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    expect(h.sent).toEqual([["A", 3]]);
    h.sync.set("A", 4); // tapped again while 3 is being saved
    await h.reply(2); // even a clamp, for an overtaken number, is ignored
    expect(h.serverQty).toEqual([]);
    expect(h.idle()).toBe(0); // 4 is still waiting
    expect(h.sync.isDirty("A")).toBe(true);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    expect(h.sent).toEqual([["A", 3], ["A", 4]]);
    await h.reply();
    expect(h.serverQty).toEqual([]);
    expect(h.idle()).toBe(1);
  });

  it("passes on a clamp for the newest number", async () => {
    const h = harness();
    h.sync.set("A", 12);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.reply(10);
    expect(h.serverQty).toEqual([["A", 10]]);
  });

  it("saves one line at a time across the cart", async () => {
    const h = harness();
    h.sync.set("A", 2);
    h.sync.set("B", 5);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    expect(h.sent).toEqual([["A", 2]]); // B waits for A's save to finish
    await h.reply();
    expect(h.sent).toEqual([["A", 2], ["B", 5]]);
    expect(h.idle()).toBe(0);
    await h.reply();
    expect(h.idle()).toBe(1);
  });

  it("skips a queued save a newer one has overtaken", async () => {
    const h = harness();
    h.sync.set("B", 1);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS); // B in flight
    h.sync.set("A", 2);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS); // A:2 queued behind B
    h.sync.set("A", 3);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS); // A:3 queued too
    await h.reply(); // B done; A:2 is overtaken and skipped
    expect(h.sent).toEqual([["B", 1], ["A", 3]]);
    await h.reply();
    expect(h.sent).toEqual([["B", 1], ["A", 3]]);
    expect(h.idle()).toBe(1);
  });

  it("cancel drops a waiting number and ignores a reply still on its way", async () => {
    const h = harness();
    h.sync.set("A", 4);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    h.sync.set("A", 5);
    h.sync.cancel("A");
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.reply(3);
    expect(h.sent).toEqual([["A", 4]]);
    expect(h.serverQty).toEqual([]);
    expect(h.sync.isDirty("A")).toBe(false);
  });

  it("runs a removal in the same line as the saves, then asks for a refresh", async () => {
    const h = harness();
    const order: string[] = [];
    h.sync.set("A", 2);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    const done = h.sync.run(async () => { order.push("remove B"); });
    expect(order).toEqual([]); // waits for A's save
    await h.reply();
    await done;
    expect(order).toEqual(["remove B"]);
    expect(h.idle()).toBe(1);
  });

  it("a task can skip the refresh", async () => {
    const h = harness();
    await h.sync.run(async () => {}, { refresh: false });
    expect(h.idle()).toBe(0);
  });

  it("flush sends waiting numbers at once", async () => {
    const h = harness();
    h.sync.set("A", 2);
    h.sync.set("B", 3);
    h.sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toEqual([["A", 2]]);
    await h.reply();
    expect(h.sent).toEqual([["A", 2], ["B", 3]]);
  });

  it("reports a failed save and still goes idle, so the screen reloads the cart", async () => {
    const h = harness();
    h.sync.set("A", 2);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    const err = new Error("offline");
    await h.fail(err);
    expect(h.errors).toEqual([["A", err]]);
    expect(h.idle()).toBe(1);
    expect(h.sync.busy).toBe(false);
  });

  it("is busy from the first tap until the last save is done", async () => {
    const h = harness();
    expect(h.sync.busy).toBe(false);
    h.sync.set("A", 2);
    expect(h.sync.busy).toBe(true);
    expect(h.sync.isDirty("A")).toBe(true);
    expect(h.sync.isDirty("B")).toBe(false);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    expect(h.sync.busy).toBe(true);
    expect(h.sync.isDirty("A")).toBe(true);
    await h.reply();
    expect(h.sync.busy).toBe(false);
    expect(h.sync.isDirty("A")).toBe(false);
    expect(h.busy).toEqual([true, false]);
  });

  // Nov review: CartView refreshed the page after every save. That refresh
  // sat in Next's router queue, the next save queued behind it unsent, and
  // Back or a link then dropped it. Each save's reply already carries the
  // fresh cart, so the screen only reloads when something failed.
  it("says nothing failed when it goes idle after good saves, so the cart does not reload", async () => {
    const h = harness();
    h.sync.set("A", 2);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.reply();
    await h.sync.run(async () => {});
    expect(h.idles).toEqual([false, false]);
  });

  it("says something failed when any save since the last idle failed, even if a later one went through", async () => {
    const h = harness();
    h.sync.set("A", 2);
    h.sync.set("B", 3);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.fail(new Error("offline"));
    await h.reply();
    expect(h.idles).toEqual([true]);
    h.sync.set("A", 4);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.reply();
    expect(h.idles).toEqual([true, false]);
  });

  // Nov review: after a failed save the line kept the unsaved number while
  // Submit came back, so a buyer could order 5 under a screen showing 6.
  it("puts a line back to what the server holds when its save fails, before it stops being busy", async () => {
    const h = harness();
    h.sync.noteSaved("A", 5);
    h.sync.set("A", 6);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.fail(new Error("Cart save failed"));
    expect(h.serverQty).toEqual([["A", 5]]);
    expect(h.log.indexOf("show A=5")).toBeLessThan(h.log.indexOf("busy false"));
    expect(h.sync.isDirty("A")).toBe(false);
  });

  it("goes back to the last number a save stored, not the page's older one", async () => {
    const h = harness();
    h.sync.noteSaved("A", 5);
    h.sync.set("A", 6);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.reply();
    expect(h.sync.savedQty("A")).toBe(6);
    h.sync.set("A", 7);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.fail(new Error("offline"));
    expect(h.serverQty).toEqual([["A", 6]]);
  });

  it("leaves a line alone when its failed save was overtaken by a newer tap", async () => {
    const h = harness();
    h.sync.noteSaved("A", 5);
    h.sync.set("A", 6);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    h.sync.set("A", 7); // tapped again while 6 is being saved
    await h.fail(new Error("offline"));
    expect(h.serverQty).toEqual([]);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    expect(h.sent).toEqual([["A", 6], ["A", 7]]);
  });

  it("leaves a line alone when it does not know what the server holds", async () => {
    const h = harness();
    h.sync.set("A", 3);
    await vi.advanceTimersByTimeAsync(CART_SAVE_DELAY_MS);
    await h.fail(new Error("offline"));
    expect(h.serverQty).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });
});
