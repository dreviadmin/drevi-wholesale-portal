import { describe, it, expect } from "vitest";
import { exGstCost, landedCost, expectedBillTotal, billMismatch } from "./gst";

describe("receipt GST semantics (2 Aug)", () => {
  it("kaccha: entered price is both the ex-GST and landed cost", () => {
    expect(exGstCost(1000, { mode: "kaccha", rate: null, inclusive: null })).toBe(1000);
    expect(landedCost(1000, { mode: "kaccha", rate: null, inclusive: null })).toBe(1000);
  });

  it("pakka inclusive 5%: ex-GST strips the tax, landed is as entered", () => {
    expect(exGstCost(1050, { mode: "pakka", rate: 5, inclusive: true })).toBe(1000);
    expect(landedCost(1050, { mode: "pakka", rate: 5, inclusive: true })).toBe(1050);
  });

  it("pakka exclusive 18%: entered is ex-GST, landed adds the tax", () => {
    expect(exGstCost(1000, { mode: "pakka", rate: 18, inclusive: false })).toBe(1000);
    expect(landedCost(1000, { mode: "pakka", rate: 18, inclusive: false })).toBe(1180);
  });

  it("no mode set behaves like kaccha", () => {
    expect(exGstCost(750, { mode: null, rate: null, inclusive: null })).toBe(750);
  });
});

describe("bill amount vs itemised total", () => {
  const onTop = { mode: "pakka" as const, rate: 5, inclusive: false };
  const incl = { mode: "pakka" as const, rate: 5, inclusive: true };
  const kaccha = { mode: "kaccha" as const, rate: null, inclusive: null };

  it("GST on top: the bill is expected to carry the tax", () => {
    expect(expectedBillTotal(10000, onTop)).toBeCloseTo(10500);
    // The case that used to badge every on-top receipt "differs by ₹500".
    expect(billMismatch(10500, 10000, onTop)).toBeNull();
    expect(billMismatch(10000, 10000, onTop)).toBeCloseTo(500);
  });

  it("inclusive and kaccha compare against the lines as entered", () => {
    expect(expectedBillTotal(10500, incl)).toBe(10500);
    expect(billMismatch(10500, 10500, incl)).toBeNull();
    expect(billMismatch(10000, 10000, kaccha)).toBeNull();
    expect(billMismatch(10200, 10000, kaccha)).toBe(200);
  });

  it("totals-level, so an odd unit cost cannot trip the ₹1 tolerance", () => {
    // 7 × ₹333.33 on top at 5% = ₹2449.98; a bill rounded to ₹2450 matches.
    expect(billMismatch(2450, 7 * 333.33, onTop)).toBeNull();
  });

  it("no badge without a bill amount", () => {
    expect(billMismatch(null, 10000, onTop)).toBeNull();
    expect(billMismatch(0, 10000, kaccha)).toBeNull();
  });
});
