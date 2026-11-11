import { describe, expect, it } from "vitest";
import { catalogFiltersFrom, catalogHref, savedScroll, scrollToRestore } from "./catalog-url";

const from = (qs: string) => catalogFiltersFrom(new URLSearchParams(qs));

describe("catalogFiltersFrom", () => {
  it("is everything when the URL has no filters", () => {
    expect(from("")).toEqual({ category: "All", sub: null, query: "" });
    expect(catalogFiltersFrom(null)).toEqual({ category: "All", sub: null, query: "" });
  });
  it("reads the /home category deep links, %20 and + alike", () => {
    expect(from("cat=Suit%20Set&sub=Palazzo%20Suit")).toEqual({ category: "Suit Set", sub: "Palazzo Suit", query: "" });
    expect(from("cat=Suit+Set")).toEqual({ category: "Suit Set", sub: null, query: "" });
  });
  it("ignores a sub-category with no category", () => {
    expect(from("sub=Anarkali")).toEqual({ category: "All", sub: null, query: "" });
  });
  it("reads the search", () => {
    expect(from("cat=Lehenga&q=silk").query).toBe("silk");
  });
});

describe("catalogHref", () => {
  it("is plain /catalog with nothing set", () => {
    expect(catalogHref({ category: "All", sub: null, query: "" })).toBe("/catalog");
    expect(catalogHref({ category: "All", sub: null, query: "   " })).toBe("/catalog");
  });
  it("drops q when the search is cleared", () => {
    expect(catalogHref({ category: "Lehenga", sub: null, query: "" })).toBe("/catalog?cat=Lehenga");
  });
  it("never writes a sub-category without its category", () => {
    expect(catalogHref({ category: "All", sub: "Anarkali", query: "" })).toBe("/catalog");
  });
  it("round-trips through the URL", () => {
    const f = { category: "Suit Set", sub: "Palazzo Suit", query: "silk & zari" };
    const href = catalogHref(f);
    expect(href.startsWith("/catalog?")).toBe(true);
    expect(catalogFiltersFrom(new URLSearchParams(href.split("?")[1]))).toEqual(f);
  });
});

describe("scrollToRestore", () => {
  const url = "/catalog?cat=Lehenga&q=silk";
  it("puts the scroll back on Back to the same URL", () => {
    expect(scrollToRestore(savedScroll(url, 1834.6), url, true)).toBe(1835);
  });
  it("leaves a fresh visit to the same filters at the top", () => {
    expect(scrollToRestore(savedScroll(url, 1834), url, false)).toBeNull();
  });
  it("ignores a position saved on other filters", () => {
    expect(scrollToRestore(savedScroll("/catalog?cat=Gown", 900), url, true)).toBeNull();
  });
  it("ignores nothing saved, the top of the page and junk", () => {
    expect(scrollToRestore(null, url, true)).toBeNull();
    expect(scrollToRestore(savedScroll(url, 0), url, true)).toBeNull();
    expect(scrollToRestore("{not json", url, true)).toBeNull();
    expect(scrollToRestore(JSON.stringify({ url, y: "12" }), url, true)).toBeNull();
  });
});
