import { describe, it, expect } from "vitest";
import { exGstCost, landedCost } from "./gst";

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
