import { describe, expect, it } from "vitest";
import { deriveBadge, shopifyGate, wholesaleGate, type DesignStateInput } from "./state";

// Gates are the contract Stage 7 pushes will call — pin them down (guide §7.2).

const base: DesignStateInput = {
  specsVerified: false,
  approvedAngles: {},
  reviewAngles: {},
  copyStatus: "none",
  targets: [
    { portal: "wholesale", enabled: true, state: "not_ready" },
    { portal: "shopify", enabled: true, state: "not_ready" },
  ],
  wholesalePriceSet: false,
  tier: "standard",
};

describe("wholesaleGate", () => {
  it("blocks with no approved image and no price", () => {
    const g = wholesaleGate(base);
    expect(g.ready).toBe(false);
    expect(g.blockers).toHaveLength(2);
  });
  it("passes with one approved image + price (raw-only design publishes)", () => {
    const g = wholesaleGate({ ...base, approvedAngles: { detail_1: true }, wholesalePriceSet: true });
    expect(g.ready).toBe(true);
  });
});

describe("shopifyGate", () => {
  it("requires front AND back, approved copy, and a tier", () => {
    expect(shopifyGate({ ...base, approvedAngles: { front: true } }).blockers).toContain("Back image not approved");
    expect(shopifyGate({ ...base, approvedAngles: { front: true, back: true }, copyStatus: "draft" }).blockers).toContain("Copy not approved");
    expect(shopifyGate({ ...base, approvedAngles: { front: true, back: true }, copyStatus: "approved", tier: null }).blockers).toEqual(["Tier not set"]);
    expect(shopifyGate({ ...base, approvedAngles: { front: true, back: true }, copyStatus: "approved" }).ready).toBe(true);
  });
});

describe("deriveBadge", () => {
  it("walks the pipeline order", () => {
    expect(deriveBadge(base).badge).toBe("awaiting_specs");
    const specs = { ...base, specsVerified: true };
    expect(deriveBadge(specs).badge).toBe("needs_photos");
    expect(deriveBadge({ ...specs, reviewAngles: { front: true } }).badge).toBe("in_review");
    expect(deriveBadge({ ...specs, approvedAngles: { front: true } }).badge).toBe("needs_copy");
    const ready = { ...specs, approvedAngles: { front: true }, wholesalePriceSet: true };
    expect(deriveBadge(ready)).toEqual({ badge: "ready", portals: ["wholesale"] });
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
