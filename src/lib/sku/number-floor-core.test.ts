import { describe, it, expect } from "vitest";
import { combineFloors } from "./number-floor-core";

describe("combineFloors", () => {
  it("takes the highest floor, the retail master included", () => {
    // The preview used to skip the master floor and show 13 while the mint gave 41.
    expect(combineFloors(12, { floor: 40 }, { floor: 7 })).toEqual({ floor: 40, warnings: [] });
    expect(combineFloors(55, { floor: 40 }, { floor: 7 }).floor).toBe(55);
    expect(combineFloors(12, { floor: 40 }, { floor: 61 }).floor).toBe(61);
  });

  it("keeps every source's warning, in order", () => {
    expect(
      combineFloors(3, { floor: 0, warning: "retail master floor unavailable: x" }, { floor: 0, warning: "sheet floor unavailable: y" }),
    ).toEqual({ floor: 3, warnings: ["retail master floor unavailable: x", "sheet floor unavailable: y"] });
  });

  it("is 0 with nothing used yet, and ignores bad values", () => {
    expect(combineFloors(0)).toEqual({ floor: 0, warnings: [] });
    expect(combineFloors(Number.NaN, { floor: -4 }, { floor: Number.POSITIVE_INFINITY }).floor).toBe(0);
    expect(combineFloors(9.7, { floor: 2 }).floor).toBe(9);
  });
});
