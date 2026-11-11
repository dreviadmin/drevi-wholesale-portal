import { describe, it, expect } from "vitest";
import { boardPath, boardQuery, parseBoardQuery, DEFAULT_BOARD_SORT, type BoardView } from "./board-url";

const base: BoardView = {
  chip: "all",
  specs: "any",
  photos: new Set(),
  missing: new Set(),
  buckets: new Set(),
  query: "",
  sort: DEFAULT_BOARD_SORT,
  showDiscontinued: false,
};
const parse = (q: string) => parseBoardQuery(new URLSearchParams(q));

describe("boardQuery / parseBoardQuery", () => {
  it("the default board is a bare address", () => {
    expect(boardQuery(base)).toBe("");
    expect(boardPath(base)).toBe("/admin/studio");
    expect(parse("")).toEqual(base);
  });

  it("round-trips every part of the view", () => {
    const view: BoardView = {
      chip: "needs_copy",
      specs: "confirmed",
      photos: new Set([3, 1]),
      missing: new Set(["fabric", "origin"]),
      buckets: new Set(["c_rush", "none"]),
      query: "KUR",
      sort: { key: "photos", dir: "desc" },
      showDiscontinued: true,
    };
    const q = boardQuery(view);
    expect(q).toBe("state=needs_copy&specs=confirmed&photos=1%2C3&missing=origin%2Cfabric&bucket=c_rush%2Cnone&q=KUR&sort=photos&dir=desc&disc=1");
    expect(parse(q)).toEqual(view);
    expect(boardPath(view)).toBe(`/admin/studio?${q}`);
  });

  it("keeps the old keys exactly as the cockpit links write them", () => {
    expect(boardQuery({ ...base, chip: "needs_photos" })).toBe("state=needs_photos");
    expect(parse("state=awaiting_specs").chip).toBe("awaiting_specs");
    expect(parse("missing=retail_price,colour").missing).toEqual(new Set(["retail_price", "colour"]));
  });

  it("writes the sort only when it is not newest first, and both halves of it", () => {
    expect(boardQuery({ ...base, sort: { key: "added", dir: "desc" } })).toBe("");
    expect(boardQuery({ ...base, sort: { key: "added", dir: "asc" } })).toBe("sort=added&dir=asc");
    expect(boardQuery({ ...base, sort: { key: "sku", dir: "asc" } })).toBe("sort=sku&dir=asc");
  });

  it("refuses a sort key that is not a board column, or a missing direction", () => {
    expect(parse("sort=password&dir=asc").sort).toEqual(DEFAULT_BOARD_SORT);
    expect(parse("sort=constructor&dir=asc").sort).toEqual(DEFAULT_BOARD_SORT);
    expect(parse("sort=photos").sort).toEqual(DEFAULT_BOARD_SORT);
    expect(parse("sort=photos&dir=sideways").sort).toEqual(DEFAULT_BOARD_SORT);
    expect(boardQuery({ ...base, sort: { key: "password", dir: "asc" } })).toBe("");
  });

  it("drops junk part by part and keeps the rest", () => {
    const v = parse("state=bogus&specs=maybe&photos=1,9,x,2.5,4&missing=fabric,nope&bucket=c_ok,Bad Key,none&disc=yes&q=KUR");
    expect(v.chip).toBe("all");
    expect(v.specs).toBe("any");
    expect(v.photos).toEqual(new Set([1, 4]));
    expect(v.missing).toEqual(new Set(["fabric"]));
    expect(v.buckets).toEqual(new Set(["c_ok", "none"]));
    expect(v.showDiscontinued).toBe(false);
    expect(v.query).toBe("KUR");
  });

  it("does not take a prototype name for a state chip", () => {
    expect(parse("state=toString").chip).toBe("all");
    expect(parse("state=__proto__").chip).toBe("all");
  });

  it("trims the search and keeps spaces and dashes inside it", () => {
    expect(boardQuery({ ...base, query: "  dd-kur-flr 2 " })).toBe("q=dd-kur-flr+2");
    expect(parse("q=dd-kur-flr+2").query).toBe("dd-kur-flr 2");
    expect(boardQuery({ ...base, query: "   " })).toBe("");
  });

  it("caps an over-long search", () => {
    const long = "A".repeat(300);
    expect(parse(boardQuery({ ...base, query: long })).query).toHaveLength(100);
  });
});
