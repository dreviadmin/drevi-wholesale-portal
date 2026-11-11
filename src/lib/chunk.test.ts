import { describe, it, expect } from "vitest";
import { chunk, inRuns } from "./chunk";

describe("chunk", () => {
  it("gives nothing for an empty list", () => {
    expect(chunk([], 150)).toEqual([]);
  });

  it("splits an exact multiple into full runs", () => {
    expect(chunk([1, 2, 3, 4, 5, 6], 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("puts the remainder in a shorter last run, order kept", () => {
    expect(chunk(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("keeps a short list whole", () => {
    expect(chunk([1, 2], 150)).toEqual([[1, 2]]);
  });

  it("covers every item of a large selection exactly once", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `id-${i}`);
    const runs = chunk(ids, 150);
    expect(runs).toHaveLength(14);
    expect(runs.every((r) => r.length <= 150)).toBe(true);
    expect(runs.flat()).toEqual(ids);
  });

  it("does not change the list it was given", () => {
    const xs = [1, 2, 3];
    chunk(xs, 2)[0].push(99);
    expect(xs).toEqual([1, 2, 3]);
  });

  it("refuses a size that would loop forever or lose items", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
    expect(() => chunk([1], Number.NaN)).toThrow(RangeError);
  });
});

describe("inRuns", () => {
  it("runs nothing for an empty list", async () => {
    let calls = 0;
    const r = await inRuns([], 100, async () => { calls++; return { data: [1], error: null }; });
    expect(calls).toBe(0);
    expect(r).toEqual({ data: [], error: null, done: 0 });
  });

  it("asks once per chunk, in order, and joins the rows", async () => {
    const seen: string[][] = [];
    const ids = Array.from({ length: 250 }, (_, i) => `d${i}`);
    const r = await inRuns(ids, 100, async (part) => {
      seen.push(part);
      return { data: part.map((id) => ({ id })), error: null };
    });
    expect(seen.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(r.error).toBeNull();
    expect(r.done).toBe(250);
    expect(r.data.map((x) => x.id)).toEqual(ids);
  });

  it("hands back the error as given, code and all", async () => {
    const r = await inRuns(["a"], 1, async () => ({ data: null, error: { message: "relation missing", code: "42P01" } }));
    expect(r.error).toEqual({ message: "relation missing", code: "42P01" });
    expect(r.done).toBe(0);
  });

  it("takes a write that returns no rows", async () => {
    const r = await inRuns(["a", "b", "c"], 2, async () => ({ data: null, error: null }));
    expect(r).toEqual({ data: [], error: null, done: 3 });
  });

  it("stops at the first error and says how far it got", async () => {
    let calls = 0;
    const r = await inRuns([1, 2, 3, 4, 5], 2, async (part) => {
      calls++;
      return calls === 2 ? { data: null, error: { message: "URI too long" } } : { data: part, error: null };
    });
    expect(calls).toBe(2);
    expect(r).toEqual({ data: [1, 2], error: { message: "URI too long" }, done: 2 });
  });
});
