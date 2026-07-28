import { describe, it, expect } from "vitest";
import { canonicalFromMovements, type Movement, type MovementReason } from "./stock-ledger-core";

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
