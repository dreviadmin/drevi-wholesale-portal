import { describe, it, expect } from "vitest";
import { lanes } from "./lanes";

describe("week grid lanes", () => {
  it("gives a booking alone the whole column", () => {
    expect(lanes([{ id: "a", s: 720, e: 750 }]).get("a")).toEqual({ i: 0, n: 1 });
  });
  it("puts overlapping bookings side by side, and a later one back to full width", () => {
    const l = lanes([{ id: "a", s: 600, e: 630 }, { id: "b", s: 615, e: 660 }, { id: "c", s: 700, e: 730 }]);
    expect(l.get("a")).toEqual({ i: 0, n: 2 });
    expect(l.get("b")).toEqual({ i: 1, n: 2 });
    expect(l.get("c")).toEqual({ i: 0, n: 1 });
  });
  it("reuses a lane once it is free, keeping the group's width", () => {
    // a 12-1, b 12:30-1:30, c 1-1:30 (takes a's lane back): one group of two lanes.
    const l = lanes([{ id: "c", s: 780, e: 810 }, { id: "a", s: 720, e: 780 }, { id: "b", s: 750, e: 810 }]);
    expect(l.get("a")).toEqual({ i: 0, n: 2 });
    expect(l.get("b")).toEqual({ i: 1, n: 2 });
    expect(l.get("c")).toEqual({ i: 0, n: 2 });
  });
  it("back-to-back bookings do not share", () => {
    const l = lanes([{ id: "a", s: 720, e: 750 }, { id: "b", s: 750, e: 780 }]);
    expect(l.get("a")).toEqual({ i: 0, n: 1 });
    expect(l.get("b")).toEqual({ i: 0, n: 1 });
  });
});
