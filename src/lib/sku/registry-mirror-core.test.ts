import { describe, it, expect } from "vitest";
import { MIRROR_MIN_AGE_MS, planMirror } from "./registry-mirror-core";

const NOW = Date.parse("2026-11-20T16:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (id: string, variant_sku: string, ageMs: number) => ({ id, variant_sku, created_at: ago(ageMs) });

describe("planMirror", () => {
  it("appends pending rows that are old enough and not on the sheet", () => {
    const a = row("1", "DD-LHG-BRD-041-M-RED", 10 * 60_000);
    const plan = planMirror([a], ["DD-LHG-BRD-040-M-RED"], NOW);
    expect(plan).toEqual({ append: [a], alreadyOnSheet: [], tooNew: [] });
  });

  it("never appends a variant the sheet already has (a second run, or a run that stopped before marking)", () => {
    const a = row("1", "DD-LHG-BRD-041-M-RED", 10 * 60_000);
    const plan = planMirror([a], ["dd-lhg-brd-041-m-red "], NOW);
    expect(plan.append).toEqual([]);
    expect(plan.alreadyOnSheet).toEqual([a]);
  });

  it("leaves a row minted in the last two minutes to the inline mirror", () => {
    const fresh = row("1", "DD-SUT-ANK-007-L-BLU", 30_000);
    const edge = row("2", "DD-SUT-ANK-008-L-BLU", MIRROR_MIN_AGE_MS);
    const plan = planMirror([fresh, edge], [], NOW);
    expect(plan.tooNew).toEqual([fresh]);
    expect(plan.append).toEqual([edge]);
  });

  it("a fresh row already on the sheet waits too (the inline mirror marks it)", () => {
    const fresh = row("1", "DD-SUT-ANK-007-L-BLU", 5_000);
    expect(planMirror([fresh], ["DD-SUT-ANK-007-L-BLU"], NOW).tooNew).toEqual([fresh]);
  });

  it("treats an unreadable timestamp as old, so the row is not stuck", () => {
    const odd = { id: "1", variant_sku: "DD-SAR-BNR-002-F-GRN", created_at: "not a date" };
    expect(planMirror([odd], [], NOW).append).toEqual([odd]);
  });

  it("keeps the pending order and ignores blank sheet cells", () => {
    const a = row("1", "DD-A-B-001-M-RED", 9e5), b = row("2", "DD-A-B-002-M-RED", 9e5), c = row("3", "DD-A-B-003-M-RED", 9e5);
    const plan = planMirror([a, b, c], ["", "DD-A-B-002-M-RED"], NOW);
    expect(plan.append).toEqual([a, c]);
    expect(plan.alreadyOnSheet).toEqual([b]);
  });
});
