import { describe, expect, it } from "vitest";
import { deriveBadge, shopifyGate, wholesaleGate, type DesignStateInput } from "./state";

// Gates are the contract Stage 7 pushes call — pin them down (guide §7.2).
// 17 Sep semantics: a slot counts once it holds an EFFECTIVE image (approved
// candidate, else a source) and copy counts once a real draft exists. The
// approval stamp gates nothing any more — the manual push is the control.

const base: DesignStateInput = {
  specsVerified: false,
  filledAngles: {},
  reviewAngles: {},
  copyStatus: "none",
  copyPresent: false,
  targets: [
    { portal: "wholesale", enabled: true, state: "not_ready" },
    { portal: "shopify", enabled: true, state: "not_ready" },
  ],
  wholesalePriceSet: false,
  tier: "standard",
  // Set on the fixture so the tests below keep testing what they were written
  // to test. The origin blocker gets its own case.
  origin: "curated",
};

describe("wholesaleGate", () => {
  it("blocks with no image and no price", () => {
    const g = wholesaleGate(base);
    expect(g.ready).toBe(false);
    expect(g.blockers).toHaveLength(2);
  });
  it("passes with one filled slot + price — an unapproved source is enough", () => {
    const g = wholesaleGate({ ...base, filledAngles: { detail_1: true }, wholesalePriceSet: true });
    expect(g.ready).toBe(true);
  });
});

describe("shopifyGate", () => {
  it("requires an origin — it picks the size ladder and the product page's pricing tier", () => {
    const shot = { ...base, filledAngles: { front: true, back: true }, copyStatus: "draft" as const, copyPresent: true };
    expect(shopifyGate({ ...shot, origin: null }).blockers).toEqual(["Origin not set"]);
    expect(shopifyGate({ ...shot, origin: "   " }).blockers).toEqual(["Origin not set"]);
    expect(shopifyGate({ ...shot, origin: undefined }).blockers).toEqual(["Origin not set"]);
    expect(shopifyGate({ ...shot, origin: "drevi_original" }).ready).toBe(true);
    // Wholesale does not read origin, so it must not be blocked on one — a
    // garment would otherwise be held off sale over a field its push ignores.
    expect(wholesaleGate({ ...base, filledAngles: { front: true }, wholesalePriceSet: true, origin: null }).ready).toBe(true);
  });

  it("requires front AND back filled, copy present, and a tier", () => {
    expect(shopifyGate({ ...base, filledAngles: { front: true } }).blockers).toContain("Back image missing");
    expect(shopifyGate({ ...base, filledAngles: { front: true, back: true } }).blockers).toContain("Copy not written");
    expect(shopifyGate({ ...base, filledAngles: { front: true, back: true }, copyStatus: "draft", copyPresent: true, tier: null }).blockers).toEqual(["Tier not set"]);
    expect(shopifyGate({ ...base, filledAngles: { front: true, back: true }, copyStatus: "draft", copyPresent: true }).ready).toBe(true);
  });
  it("a draft with empty title or description does not pass (copyPresent is the contract)", () => {
    // loadBoard only sets copyPresent when title AND description are non-empty.
    const g = shopifyGate({ ...base, filledAngles: { front: true, back: true }, copyStatus: "draft", copyPresent: false });
    expect(g.blockers).toEqual(["Copy not written"]);
  });
});

describe("deriveBadge", () => {
  it("walks the pipeline order", () => {
    expect(deriveBadge(base).badge).toBe("awaiting_specs");
    const specs = { ...base, specsVerified: true };
    expect(deriveBadge(specs).badge).toBe("needs_photos");
    // Legacy arm: a candidate whose source vanished still reads in_review.
    expect(deriveBadge({ ...specs, reviewAngles: { front: true } }).badge).toBe("in_review");
    expect(deriveBadge({ ...specs, filledAngles: { front: true } }).badge).toBe("needs_copy");
    const ready = { ...specs, filledAngles: { front: true }, wholesalePriceSet: true };
    expect(deriveBadge(ready)).toEqual({ badge: "ready", portals: ["wholesale"] });
  });
  it("an unapproved candidate no longer blocks — its filled slot drives the badge", () => {
    const specs = { ...base, specsVerified: true };
    const withCandidate = { ...specs, filledAngles: { front: true }, reviewAngles: { front: true }, wholesalePriceSet: true };
    expect(deriveBadge(withCandidate)).toEqual({ badge: "ready", portals: ["wholesale"] });
  });
  it("live and changes_pending outrank everything", () => {
    const live = { ...base, targets: [{ portal: "wholesale" as const, enabled: true, state: "live" as const }] };
    expect(deriveBadge(live)).toEqual({ badge: "live", portals: ["wholesale"] });
    const pending = { ...base, targets: [{ portal: "wholesale" as const, enabled: true, state: "changes_pending" as const }] };
    expect(deriveBadge(pending).badge).toBe("changes_pending");
  });
  it("ignores disabled portals", () => {
    const disabledLive = { ...base, targets: [{ portal: "shopify" as const, enabled: false, state: "live" as const }] };
    expect(deriveBadge(disabledLive).badge).toBe("awaiting_specs");
  });
});
