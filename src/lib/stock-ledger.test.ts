import { describe, it, expect } from "vitest";
import { canonicalBySku, canonicalFromMovements, openingBalanceFor, sheetSyncQty, type Movement, type MovementReason } from "./stock-ledger-core";

let seq = 0;
function m(reason: MovementReason, opts: { delta?: number; snapshot?: number; day: number }): Movement {
  return {
    id: `m${seq++}`,
    sku: "DD-LEH-FLR-001-M-BLU",
    delta: opts.delta ?? 0,
    snapshot_qty: opts.snapshot ?? null,
    reason,
    ref_type: null,
    ref_id: null,
    note: null,
    created_by: null,
    created_at: `2026-07-${String(opts.day).padStart(2, "0")}T10:00:00.000Z`,
  };
}

describe("canonical stock from the ledger (§3.5, §10)", () => {
  it("is zero with no movements", () => {
    expect(canonicalFromMovements([])).toBe(0);
  });

  it("sums deltas when nothing has been counted yet", () => {
    expect(canonicalFromMovements([
      m("receipt", { delta: 10, day: 1 }),
      m("order", { delta: -3, day: 2 }),
      m("receipt", { delta: 5, day: 3 }),
    ])).toBe(12);
  });

  it("a reset supersedes everything before it", () => {
    expect(canonicalFromMovements([
      m("receipt", { delta: 100, day: 1 }),
      m("order", { delta: -40, day: 2 }),
      m("reset", { snapshot: 7, day: 3 }),
    ])).toBe(7);
  });

  it("later movements add on top of the reset", () => {
    expect(canonicalFromMovements([
      m("receipt", { delta: 100, day: 1 }),
      m("reset", { snapshot: 7, day: 3 }),
      m("receipt", { delta: 12, day: 4 }),
      m("order", { delta: -5, day: 5 }),
    ])).toBe(14);
  });

  // §13.9a — the acceptance example, with its exact numbers.
  it("acceptance §13.9a: reset 12 over prior receipts yields 12; a later receipt of 3 yields 15", () => {
    const history = [
      m("receipt", { delta: 40, day: 1 }),
      m("order", { delta: -6, day: 2 }),
    ];
    const afterReset = [...history, m("reset", { snapshot: 12, day: 3 })];
    expect(canonicalFromMovements(afterReset)).toBe(12);

    const afterReceipt = [...afterReset, m("receipt", { delta: 3, day: 4 })];
    expect(canonicalFromMovements(afterReceipt)).toBe(15);
    // Earlier movements remain — visible history, zero contribution.
    expect(afterReceipt).toHaveLength(4);
  });

  it("only the MOST RECENT reset counts", () => {
    expect(canonicalFromMovements([
      m("reset", { snapshot: 50, day: 1 }),
      m("receipt", { delta: 10, day: 2 }),
      m("reset", { snapshot: 3, day: 3 }),
      m("order", { delta: -1, day: 4 }),
    ])).toBe(2);
  });

  it("does not depend on the order rows arrive in", () => {
    const rows = [
      m("order", { delta: -5, day: 5 }),
      m("reset", { snapshot: 7, day: 3 }),
      m("receipt", { delta: 100, day: 1 }),
      m("receipt", { delta: 12, day: 4 }),
    ];
    expect(canonicalFromMovements(rows)).toBe(14);
    expect(canonicalFromMovements([...rows].reverse())).toBe(14);
  });

  it("a reset to zero is a real declaration, not a missing value", () => {
    expect(canonicalFromMovements([
      m("receipt", { delta: 40, day: 1 }),
      m("reset", { snapshot: 0, day: 2 }),
    ])).toBe(0);
  });

  it("keeps history visible but non-contributing — earlier rows are never dropped", () => {
    const rows = [
      m("receipt", { delta: 100, day: 1 }),
      m("reset", { snapshot: 7, day: 3 }),
    ];
    expect(canonicalFromMovements(rows)).toBe(7);
    expect(rows).toHaveLength(2); // nothing deleted
  });
});

describe("canonical stock per SKU", () => {
  it("groups by upper-cased SKU and computes each one's canonical stock", () => {
    const a = (reason: MovementReason, opts: { delta?: number; snapshot?: number; day: number }) => ({ ...m(reason, opts), sku: "dd-sar-prd-067-l-rst" });
    const b = (reason: MovementReason, opts: { delta?: number; snapshot?: number; day: number }) => ({ ...m(reason, opts), sku: "DD-SUT-PLZ-024-M-RED" });
    const out = canonicalBySku([
      a("receipt", { delta: 5, day: 1 }),
      b("reset", { snapshot: 3, day: 1 }),
      a("order", { delta: -2, day: 2 }),
      b("order", { delta: -1, day: 2 }),
    ]);
    expect(out.get("DD-SAR-PRD-067-L-RST")).toBe(3);
    expect(out.get("DD-SUT-PLZ-024-M-RED")).toBe(2);
    expect(out.size).toBe(2);
  });

  it("is empty with no movements", () => {
    expect(canonicalBySku([]).size).toBe(0);
  });
});

// Audit round 2 (4 Oct) — the sheet sync no longer writes over ledger-owned stock.
// null = "leave the column alone" (the row goes up without current_qty).
describe("sheet sync current_qty (sheetSyncQty)", () => {
  const ledger = new Map([["DD-LEH-FLR-001-M-BLU", 2]]);

  it("does not write an existing SKU that has movements, whatever the sheet says", () => {
    // The finding's exact case: ledger 2, sheet 0 — the booth must not read Sold Out.
    expect(sheetSyncQty("DD-LEH-FLR-001-M-BLU", 0, true, ledger)).toBeNull();
    expect(sheetSyncQty("dd-leh-flr-001-m-blu", 9, true, ledger)).toBeNull();
  });

  it("seeds a row the sync is about to create from the ledger when the SKU has movements", () => {
    expect(sheetSyncQty("DD-LEH-FLR-001-M-BLU", 7, false, ledger)).toBe(2);
  });

  it("still takes the sheet's number for a SKU the ledger has never seen — new and existing", () => {
    expect(sheetSyncQty("DD-KUR-CTN-310-S-PNK", 6, false, ledger)).toBe(6);
    expect(sheetSyncQty("DD-KUR-CTN-310-S-PNK", 6, true, ledger)).toBe(6);
  });

  it("an unreadable ledger writes no existing row, and a new row takes the sheet", () => {
    expect(sheetSyncQty("DD-KUR-CTN-310-S-PNK", 6, true, null)).toBeNull();
    expect(sheetSyncQty("DD-KUR-CTN-310-S-PNK", 6, false, null)).toBe(6);
  });

  it("a SKU whose movements net to zero is still the ledger's", () => {
    const zero = new Map([["DD-LEH-FLR-001-M-BLU", 0]]);
    expect(sheetSyncQty("DD-LEH-FLR-001-M-BLU", 5, true, zero)).toBeNull();
    expect(sheetSyncQty("DD-LEH-FLR-001-M-BLU", 5, false, zero)).toBe(0);
  });
});

// Review fix (11 Nov): a SKU the sheet added after 0026 had its Current Qty in
// the cache and nothing in the ledger, so its first sale summed to −1 and the
// sync (now leaving ledger-owned SKUs alone) never put the 10 back.
describe("opening balance for a SKU's first movement (openingBalanceFor)", () => {
  it("a shown count becomes a reset to it; nothing for zero or an unreadable count", () => {
    expect(openingBalanceFor(10)).toEqual({ reason: "reset", delta: 0, snapshot_qty: 10 });
    expect(openingBalanceFor(0)).toBeNull();
    expect(openingBalanceFor(null)).toBeNull();
    expect(openingBalanceFor(undefined)).toBeNull();
    expect(openingBalanceFor(Number.NaN)).toBeNull();
  });

  it("a negative count is carried as a correction, since a reset is never below zero", () => {
    expect(openingBalanceFor(-2)).toEqual({ reason: "correction", delta: -2, snapshot_qty: null });
  });

  it("the first movement nets off it: 10 − 1 = 9, 10 + 3 = 13, −2 − 1 = −3", () => {
    const seeded = (shown: number) => {
      const o = openingBalanceFor(shown)!;
      return o.reason === "reset" ? m("reset", { snapshot: o.snapshot_qty, day: 1 }) : m("correction", { delta: o.delta, day: 1 });
    };
    expect(canonicalFromMovements([seeded(10), m("order", { delta: -1, day: 2 })])).toBe(9);
    expect(canonicalFromMovements([seeded(10), m("receipt", { delta: 3, day: 2 })])).toBe(13);
    expect(canonicalFromMovements([seeded(-2), m("order", { delta: -1, day: 2 })])).toBe(-3);
    // Without it, the finding's case: the 10 pieces are gone.
    expect(canonicalFromMovements([m("order", { delta: -1, day: 2 })])).toBe(-1);
  });

  it("after the seed the sync leaves the count to the ledger, which now holds it", () => {
    const movements = [m("reset", { snapshot: 10, day: 1 }), m("order", { delta: -1, day: 2 })];
    expect(sheetSyncQty("DD-LEH-FLR-001-M-BLU", 10, true, canonicalBySku(movements))).toBeNull();
    expect(canonicalBySku(movements).get("DD-LEH-FLR-001-M-BLU")).toBe(9);
  });
});
