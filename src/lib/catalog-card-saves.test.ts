import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogCardSaves, CARD_SAVE_ERROR, CARD_SAVE_WAIT } from "./catalog-card-saves";
import { UNAVAILABLE_MESSAGE } from "./cart-toast";

// Saves the test answers by hand, so it can tap, filter and leave while one runs.
type Pending = { sku: string; qty: number; resolve: (stored: number) => void; reject: (e: unknown) => void };

function harness() {
  const pending: Pending[] = [];
  const sent: [string, number][] = [];
  const log: string[] = [];
  const saves = new CatalogCardSaves({
    save: (sku, qty) => {
      sent.push([sku, qty]);
      log.push(`save ${sku}=${qty}`);
      return new Promise<number>((resolve, reject) => pending.push({ sku, qty, resolve, reject }));
    },
    showLine: (sku, qty) => log.push(`show ${sku}=${qty}`),
    toast: (m) => log.push(`toast ${m}`),
    replaceUrl: (href) => log.push(`url ${href}`),
    navigate: (href) => log.push(`go ${href}`),
  });
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
  const of = (prefix: string) => log.filter((l) => l.startsWith(prefix));
  return { saves, pending, sent, log, reply, fail, of };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("CatalogCardSaves", () => {
  it("sends one card save at a time: the next goes only once the last has answered", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    h.saves.change("B", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toEqual([["A", 1]]);
    await h.reply();
    expect(h.sent).toEqual([["A", 1], ["B", 1]]);
  });

  it("quick taps on one size send only the newest number once the first answers", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    h.saves.change("A", 2, 1);
    h.saves.change("A", 3, 2);
    await vi.advanceTimersByTimeAsync(0);
    await h.reply();
    expect(h.sent).toEqual([["A", 1], ["A", 3]]);
  });

  it("writes the address at once when nothing is saving", () => {
    const h = harness();
    h.saves.writeUrl("/catalog?cat=Lehenga");
    expect(h.of("url")).toEqual(["url /catalog?cat=Lehenga"]);
  });

  it("holds the address while a save is outstanding, then writes the newest one", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    h.saves.writeUrl("/catalog?cat=Lehenga");
    await vi.advanceTimersByTimeAsync(0);
    h.saves.writeUrl("/catalog?cat=Suit");
    expect(h.of("url")).toEqual([]);
    await h.reply();
    expect(h.of("url")).toEqual(["url /catalog?cat=Suit"]);
  });

  it("writes it a macrotask after the last reply, never in the microtasks before Next lets go of that save", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    h.saves.writeUrl("/catalog?q=rose");
    h.pending.shift()!.resolve(1);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.of("url")).toEqual([]);
    expect(h.saves.holding).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.of("url")).toEqual(["url /catalog?q=rose"]);
    expect(h.saves.holding).toBe(false);
  });

  it("navigates at once when nothing is saving", () => {
    const h = harness();
    expect(h.saves.go("/cart")).toBe(true);
    expect(h.of("go")).toEqual(["go /cart"]);
  });

  it("holds a link while a save is outstanding, says it is saving, then goes, after the address", async () => {
    const h = harness();
    h.saves.change("A", 2, 1);
    await vi.advanceTimersByTimeAsync(0);
    h.saves.writeUrl("/catalog?q=rose");
    expect(h.saves.go("/product/A")).toBe(false);
    expect(h.saves.go("/product/B")).toBe(false); // the last tap wins
    expect(h.of("toast")).toEqual([`toast ${CARD_SAVE_WAIT}`]);
    expect(h.of("go")).toEqual([]);
    await h.reply();
    expect(h.log.slice(-2)).toEqual(["url /catalog?q=rose", "go /product/B"]);
  });

  it("a failed save puts the card back to what the server holds, says so, and stays on the page", async () => {
    const h = harness();
    h.saves.change("A", 3, 2);
    await vi.advanceTimersByTimeAsync(0);
    h.saves.go("/cart");
    await h.fail(new Error("offline"));
    expect(h.of("show")).toEqual(["show A=2"]);
    expect(h.of("toast")).toContain(`toast ${CARD_SAVE_ERROR}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.of("go")).toEqual([]);
    expect(h.saves.holding).toBe(false);
  });

  it("a failed first add takes the card back to not in the cart", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    await h.fail(new Error("offline"));
    expect(h.of("show")).toEqual(["show A=0"]);
  });

  it("says Added to cart once the server has the line, and only that a sold-out size is gone", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    await h.reply(1);
    expect(h.of("toast")).toEqual(["toast Added to cart"]);
    h.saves.change("B", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    await h.reply(0);
    expect(h.of("toast")).toEqual(["toast Added to cart", `toast ${UNAVAILABLE_MESSAGE}`]);
    expect(h.of("show")).toEqual(["show B=0"]);
    // A line already in the cart says nothing on +.
    h.saves.change("A", 2, 1);
    await vi.advanceTimersByTimeAsync(0);
    await h.reply();
    expect(h.of("toast")).toHaveLength(2);
  });

  it("once the page has gone, saves still go out, but the address and the router are left alone", async () => {
    const h = harness();
    h.saves.change("A", 1, 0);
    h.saves.change("B", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    h.saves.writeUrl("/catalog?cat=Suit");
    h.saves.go("/product/A");
    h.saves.setActive(false);
    await h.reply();
    await h.reply();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sent).toEqual([["A", 1], ["B", 1]]);
    expect(h.of("url")).toEqual([]);
    expect(h.of("go")).toEqual([]);
  });
});

// Next 14.2's router action queue, cut down to what decides whether a save
// survives (next/dist/shared/lib/router/action-queue.js): one action runs at
// a time; a navigation or a history write (ACTION_RESTORE) arriving while
// another runs marks that one discarded and runs at once, and whatever was
// queued behind the discarded one is never run. A discarded server action has
// already been sent, so its promise still settles, and the queue then runs a
// refresh. Saves queued behind that refresh are lost to the next cut.
function nextRouterModel() {
  interface Act { kind: "save" | "refresh" | "cut"; exec: () => Promise<void>; next: Act | null; discarded?: boolean }
  let pending: Act | null = null;
  let last: Act | null = null;
  let needsRefresh = false;
  const replies: (() => void)[] = [];
  const refreshes: (() => void)[] = [];
  const server: Record<string, number> = {};

  function run(a: Act) {
    pending = a;
    void a.exec().then(() => {
      if (a.discarded) return;
      pending = pending?.next ?? null;
      if (pending) run(pending);
      else if (needsRefresh) { needsRefresh = false; dispatch({ kind: "refresh", next: null, exec: () => new Promise((r) => refreshes.push(r)) }); }
    });
  }
  function dispatch(a: Act) {
    if (!pending) { last = a; run(a); }
    else if (a.kind === "cut") {
      pending.discarded = true;
      if (pending.kind === "save") needsRefresh = true;
      last = a;
      run(a);
    } else { last!.next = a; last = a; }
  }
  const cut = () => dispatch({ kind: "cut", next: null, exec: async () => {} });
  const saves = new CatalogCardSaves({
    save: (sku, qty) =>
      new Promise<number>((resolve) =>
        dispatch({
          kind: "save", next: null,
          exec: () => new Promise<void>((done) => replies.push(() => { server[sku] = qty; resolve(qty); done(); })),
        }),
      ),
    showLine: () => {},
    toast: () => {},
    replaceUrl: cut,
    navigate: cut,
  });
  const answer = async () => { replies.shift()?.(); await vi.advanceTimersByTimeAsync(0); };
  const finishRefresh = async () => { refreshes.shift()?.(); await vi.advanceTimersByTimeAsync(0); };
  return { saves, server, cut, answer, finishRefresh, replies, refreshes };
}

describe("CatalogCardSaves against Next's router queue (Nov review)", () => {
  it("two taps then two chip taps: both saves land, none is dropped", async () => {
    const m = nextRouterModel();
    m.saves.change("A", 1, 0);
    await vi.advanceTimersByTimeAsync(0);
    m.saves.change("A", 2, 1);
    m.saves.writeUrl("/catalog?cat=Lehenga"); // a chip while 1 is saving
    await m.answer();
    m.saves.writeUrl("/catalog?cat=Suit"); // another while 2 is saving
    await m.finishRefresh();
    await m.answer();
    await m.finishRefresh();
    expect(m.server).toEqual({ A: 2 });
    expect(m.replies).toHaveLength(0);
    expect(m.saves.holding).toBe(false);
  });

  it("a link tapped mid-save waits for the saves, so a Back straight behind it loses none", async () => {
    const m = nextRouterModel();
    m.saves.change("A", 1, 0);
    m.saves.change("B", 3, 0);
    await vi.advanceTimersByTimeAsync(0);
    m.saves.go("/product/A");
    await m.answer();
    m.cut(); // the buyer's Back, which no page can hold
    await m.finishRefresh();
    await m.answer();
    await m.finishRefresh();
    expect(m.server).toEqual({ A: 1, B: 3 });
  });
});
