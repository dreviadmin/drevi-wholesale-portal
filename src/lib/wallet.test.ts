import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// wallet.ts talks to Supabase and Shopify. Both are replaced here: Shopify by
// spies, Supabase by a tiny query-builder fake that answers each read from
// the `db` handler below and records every call, so a test can assert that
// nothing was written. wallet-core stays real.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/wallet-core", async () => await import("./wallet-core"));

const shopify = vi.hoisted(() => ({
  addCustomerTags: vi.fn(async () => {}),
  addOrderTags: vi.fn(async () => {}),
  deleteDiscount: vi.fn(async () => {}),
  fetchWalletOrder: vi.fn(),
  getCustomer: vi.fn(),
  createWalletAutomaticDiscount: vi.fn(),
  listOrdersUpdatedBetween: vi.fn(),
  removeCustomerTags: vi.fn(async () => {}),
  setCustomerNames: vi.fn(async () => {}),
  setCustomerPhone: vi.fn(async () => "ok"),
  identifyCart: vi.fn(),
}));
vi.mock("@/lib/wallet-shopify", () => shopify);

type Op = { m: string; a: unknown[] };
type Call = { table: string; ops: Op[]; end: string };
const db = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Array<{ m: string; a: unknown[] }>; end: string }>,
  answer: (() => ({ data: null, error: null })) as (c: { table: string; ops: Array<{ m: string; a: unknown[] }>; end: string }) => { data: unknown; error: unknown },
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const ops: Op[] = [];
      const finish = (end: string) => { const c: Call = { table, ops, end }; db.calls.push(c); return Promise.resolve(db.answer(c)); };
      const builder: object = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => finish("await").then(ok, bad);
          if (prop === "maybeSingle" || prop === "single") return () => finish(prop);
          return (...a: unknown[]) => { ops.push({ m: prop, a }); return builder; };
        },
      });
      return builder;
    },
    rpc: db.rpc,
  }),
}));

import { onOrderCreated, openWalletForCustomer, reconcileRecent, type WalletAccount } from "./wallet";

const has = (c: Call, m: string, ...a: unknown[]) => c.ops.some((o) => o.m === m && a.every((x, i) => o.a[i] === x));
const writes = () => db.calls.filter((c) => c.ops.some((o) => o.m === "insert" || o.m === "update" || o.m === "delete" || o.m === "upsert"));

const ME = "gid://shopify/Customer/111";
const account = (over: Partial<WalletAccount> = {}): WalletAccount => ({
  id: "acc-1", phone: "919876543210", shopify_customer_id: ME, name: "Test", balance_paise: 100000,
  expires_at: "2027-11-01T00:00:00Z", wa_opt_in_at: "2026-10-01T00:00:00Z", source: "popup", created_at: "2026-10-01T00:00:00Z", ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/9001", name: "#1200", cancelledAt: null, financialStatus: "PENDING", fulfillmentStatus: "UNFULFILLED",
  customerId: ME, phones: ["+919876543210"], lines: [{ productType: "Saree", quantity: 1, currentQuantity: 1, paidPaise: 500000, walletAllocPaise: 100000 }],
  codeAllocations: {}, walletAutoPaise: 100000, refundedMerchandisePaise: 0, ...over,
});

beforeEach(() => {
  db.calls.length = 0;
  db.answer = () => ({ data: null, error: null });
  db.rpc.mockReset();
  for (const f of Object.values(shopify)) f.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("joining when the customer already has a wallet", () => {
  it("hands the wallet back unchanged and writes nothing to Shopify or the database", async () => {
    const mine = account();
    db.answer = (c) => (c.table === "wallet_accounts" && has(c, "eq", "shopify_customer_id", ME) ? { data: mine, error: null } : { data: null, error: null });
    const r = await openWalletForCustomer({ customerGid: ME, phone: "9123456789", name: "Someone Else", consent: false, source: "popup" });
    expect(r).toEqual({ ok: true, account: mine, created: false, phoneReview: false });
    expect(shopify.setCustomerPhone).not.toHaveBeenCalled();
    expect(shopify.addCustomerTags).not.toHaveBeenCalled();
    expect(shopify.removeCustomerTags).not.toHaveBeenCalled();
    expect(shopify.setCustomerNames).not.toHaveBeenCalled();
    expect(shopify.getCustomer).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("still opens a wallet, with the phone and tags, for a customer who has none", async () => {
    const fresh = account({ id: "acc-new", phone: "919123456789", wa_opt_in_at: null });
    shopify.getCustomer.mockResolvedValue({ id: ME, email: "a@b.co", phone: null, firstName: "A", lastName: null, tags: [] });
    db.answer = (c) => {
      if (c.table === "wallet_accounts" && c.end === "single") return { data: fresh, error: null };
      if (c.table === "wallet_accounts" && has(c, "eq", "id", "acc-new")) return { data: fresh, error: null };
      return { data: null, error: null };
    };
    db.rpc.mockResolvedValue({ data: { id: "l1", amount_paise: 100000 }, error: null });
    const r = await openWalletForCustomer({ customerGid: ME, phone: "9123456789", consent: false, source: "popup" });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(shopify.setCustomerPhone).toHaveBeenCalledWith(ME, "919123456789");
    expect(shopify.addCustomerTags).toHaveBeenCalledWith(ME, ["drevi-wallet", "source:wallet"]);
  });
});

describe("orders/create: a shortfall tags the order", () => {
  const debitScene = (debited: number | null) => {
    shopify.fetchWalletOrder.mockResolvedValue(order());
    db.answer = (c) => {
      if (c.table === "wallet_accounts" && has(c, "eq", "shopify_customer_id", ME)) return { data: account({ balance_paise: 40000 }), error: null };
      if (c.table === "wallet_redemptions" && c.end === "maybeSingle") return { data: { id: "red-1", code: "WLT-ABCDEFGH", amount_paise: 100000, shopify_discount_id: "gid://shopify/DiscountAutomaticNode/5", status: "open", expires_at: "", account_id: "acc-1" }, error: null };
      return { data: null, error: null };
    };
    // A replay: PostgREST hands back a NULL row as an object of nulls.
    db.rpc.mockResolvedValue({ data: debited === null ? { id: null, amount_paise: null } : { id: "l1", amount_paise: -debited }, error: null });
  };

  it("in production, a clamped debit is logged and tagged wallet-shortfall", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    debitScene(40000);
    const r = await onOrderCreated("gid://shopify/Order/9001");
    expect(r).toBe("debited 40000 of 100000 (SHORTFALL 60000)");
    expect(console.error).toHaveBeenCalledWith("[wallet] SHORTFALL", "#1200", { requested: 100000, debited: 40000 });
    expect(shopify.addOrderTags).toHaveBeenCalledWith("gid://shopify/Order/9001", ["wallet-shortfall"]);
  });

  it("outside production it only says it would tag", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    debitScene(40000);
    await onOrderCreated("gid://shopify/Order/9001");
    expect(shopify.addOrderTags).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith("[wallet] would tag #1200 wallet-shortfall (not production)");
  });

  it("a tag that fails never fails the webhook", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    debitScene(40000);
    shopify.addOrderTags.mockRejectedValueOnce(new Error("Throttled"));
    await expect(onOrderCreated("gid://shopify/Order/9001")).resolves.toContain("SHORTFALL 60000");
    expect(console.warn).toHaveBeenCalledWith("[wallet] tag #1200 wallet-shortfall:", "Throttled");
  });

  it("a full debit, or a replay of one already posted, tags nothing", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    debitScene(100000);
    expect(await onOrderCreated("gid://shopify/Order/9001")).toBe("debited 100000");
    debitScene(null);
    expect(await onOrderCreated("gid://shopify/Order/9001")).toBe("already debited");
    expect(shopify.addOrderTags).not.toHaveBeenCalled();
  });

  it("the wallet discount on an order with no wallet is a shortfall too", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    shopify.fetchWalletOrder.mockResolvedValue(order());
    const r = await onOrderCreated("gid://shopify/Order/9001");
    expect(r).toBe("wallet discount on an order with no wallet (SHORTFALL 100000)");
    expect(console.error).toHaveBeenCalledWith("[wallet] SHORTFALL", "#1200", { requested: 100000, debited: 0, reason: "no wallet" });
    expect(shopify.addOrderTags).toHaveBeenCalledWith("gid://shopify/Order/9001", ["wallet-shortfall"]);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe("reconcileRecent", () => {
  const scene = () => {
    shopify.listOrdersUpdatedBetween.mockResolvedValue({ orders: [{ id: "gid://shopify/Order/1", name: "#1" }, { id: "gid://shopify/Order/2", name: "#2" }, { id: "gid://shopify/Order/3", name: "#3" }], more: false });
    shopify.fetchWalletOrder.mockImplementation(async (id: string) => {
      if (id.endsWith("/1")) return order({ id, name: "#1" });                              // wallet used, no redeem row: mismatch
      if (id.endsWith("/2")) throw new Error("Throttled");                                   // can't be read: counted, skipped
      return order({ id, name: "#3", walletAutoPaise: 0, codeAllocations: {} });              // no wallet, not paid: fine
    });
    db.answer = () => ({ data: [], error: null });
  };

  it("reports and tags mismatches in production, and never posts", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    scene();
    const r = await reconcileRecent({ now: new Date("2026-11-10T03:30:00Z") });
    expect(r).toMatchObject({ ok: true, checked: 2, mismatched: 1, tagged: 1, would_tag: 0, failed: 1, truncated: false });
    expect(r.mismatches).toEqual([{ order: "#1", kind: "redeem", expectedPaise: 100000, gotPaise: 0 }]);
    expect(r.from).toBe("2026-11-07T03:30:00.000Z");
    expect(r.to).toBe("2026-11-10T02:30:00.000Z");
    expect(console.error).toHaveBeenCalledWith("[wallet-reconcile] MISMATCH #1 redeem expected 100000 got 0");
    expect(shopify.addOrderTags).toHaveBeenCalledTimes(1);
    expect(shopify.addOrderTags).toHaveBeenCalledWith("gid://shopify/Order/1", ["wallet-check"]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("outside production it tags nothing", async () => {
    scene();
    const r = await reconcileRecent();
    expect(r).toMatchObject({ mismatched: 1, tagged: 0, would_tag: 1 });
    expect(shopify.addOrderTags).not.toHaveBeenCalled();
  });

  it("reads the ledger by order across every wallet", async () => {
    scene();
    await reconcileRecent();
    const ledger = db.calls.filter((c) => c.table === "wallet_ledger");
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((c) => !has(c, "eq", "account_id"))).toBe(true);
  });

  it("stops when its time budget is spent and says so", async () => {
    scene();
    const r = await reconcileRecent({ budgetMs: -1 });
    expect(r).toMatchObject({ checked: 0, truncated: true });
  });
});
