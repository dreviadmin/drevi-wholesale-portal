import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUCKET_NONE,
  PRESET_BUCKETS,
  bucketKeyFor,
  bucketLabel,
  cleanBucketLabel,
  dropdownBuckets,
  filterBuckets,
  mergeBuckets,
  sameBucketLabel,
  type StudioBucket,
} from "./buckets";

const custom = (key: string, label: string, active = true, sort = 110): StudioBucket => ({ key, label, sort, preset: false, active });

describe("cleanBucketLabel", () => {
  it("trims and collapses spaces", () => {
    expect(cleanBucketLabel("  Needs   steaming ")).toEqual({ ok: true, label: "Needs steaming" });
  });
  it("refuses names the dropdown already uses for itself", () => {
    expect(cleanBucketLabel("not  SET").ok).toBe(false);
    expect(cleanBucketLabel("+ Add custom…").ok).toBe(false);
    expect(cleanBucketLabel("Not set yet").ok).toBe(true);
  });
  it("refuses empty and over-long names", () => {
    expect(cleanBucketLabel("   ").ok).toBe(false);
    expect(cleanBucketLabel(null).ok).toBe(false);
    expect(cleanBucketLabel("x".repeat(41)).ok).toBe(false);
    expect(cleanBucketLabel("x".repeat(40)).ok).toBe(true);
  });
});

describe("sameBucketLabel", () => {
  it("ignores capitals and spacing", () => {
    expect(sameBucketLabel("needs  shoot", "Needs Shoot")).toBe(true);
    expect(sameBucketLabel("Needs Shoot", "Needs Reshoot")).toBe(false);
  });
});

describe("bucketKeyFor", () => {
  const shape = /^[a-z0-9_]{1,48}$/;
  it("slugs with a c_ prefix that can never be a preset or the Not set token", () => {
    const k = bucketKeyFor("Needs steaming!", []);
    expect(k).toBe("c_needs_steaming");
    expect(k).toMatch(shape);
    expect(bucketKeyFor("None", [])).not.toBe(BUCKET_NONE);
    expect(bucketKeyFor("Needs Shoot", PRESET_BUCKETS.map((b) => b.key))).toBe("c_needs_shoot");
  });
  it("numbers a taken key and stays within 48 chars", () => {
    expect(bucketKeyFor("Steam", ["c_steam"])).toBe("c_steam_2");
    expect(bucketKeyFor("Steam", ["c_steam", "c_steam_2"])).toBe("c_steam_3");
    const long = "a".repeat(80);
    const first = bucketKeyFor(long, []);
    const second = bucketKeyFor(long, [first]);
    expect(first).toMatch(shape);
    expect(second).toMatch(shape);
    expect(second).not.toBe(first);
  });
  it("gives non-Latin names a usable key", () => {
    expect(bucketKeyFor("फोटो बाकी", [])).toBe("c_bucket");
    expect(bucketKeyFor("फोटो बाकी", ["c_bucket"])).toBe("c_bucket_2");
  });
});

describe("dropdownBuckets", () => {
  const all = [...PRESET_BUCKETS, custom("c_old", "Old", false), custom("c_new", "New")];
  it("offers active buckets in order", () => {
    expect(dropdownBuckets(all, null).map((b) => b.key)).toEqual(["needs_shoot", "needs_reshoot", "copy_regen", "verified", "c_new"]);
  });
  it("keeps a removed bucket only for the design that holds it", () => {
    expect(dropdownBuckets(all, "c_old").map((b) => b.key)).toContain("c_old");
  });
  it("shows a key missing from the list instead of pretending it is Not set", () => {
    expect(dropdownBuckets(PRESET_BUCKETS, "c_hold").map((b) => b.key)).toContain("c_hold");
  });
});

describe("filterBuckets", () => {
  it("shows every active bucket even at zero, removed ones only while used, and orphans by key", () => {
    const all = [...PRESET_BUCKETS, custom("c_old", "Old", false), custom("c_gone", "Gone", false)];
    const counts = new Map([["c_old", 2], ["c_ghost", 1], [BUCKET_NONE, 5]]);
    const keys = filterBuckets(all, counts).map((b) => b.key);
    expect(keys.slice(0, 4)).toEqual(["needs_shoot", "needs_reshoot", "copy_regen", "verified"]);
    expect(keys).toContain("c_old");
    expect(keys).not.toContain("c_gone");
    expect(keys).toContain("c_ghost");
    expect(keys).not.toContain(BUCKET_NONE);
  });
  it("keeps a chip for anything selected, even at zero or unknown", () => {
    const all = [...PRESET_BUCKETS, custom("c_gone", "Gone", false)];
    const keys = filterBuckets(all, new Map(), new Set(["c_gone", "c_url_typo", BUCKET_NONE])).map((b) => b.key);
    expect(keys).toContain("c_gone");
    expect(keys).toContain("c_url_typo");
    expect(keys).not.toContain(BUCKET_NONE);
  });
});

describe("bucketLabel / mergeBuckets", () => {
  it("labels Not set and unknown keys", () => {
    expect(bucketLabel(null, PRESET_BUCKETS)).toBe("Not set");
    expect(bucketLabel("verified", PRESET_BUCKETS)).toBe("Verified - all good");
    expect(bucketLabel("c_x", PRESET_BUCKETS)).toBe("c_x");
  });
  it("lets a locally added bucket appear at once and a local removal win", () => {
    const merged = mergeBuckets(PRESET_BUCKETS, [custom("c_new", "New"), { ...PRESET_BUCKETS[0], active: false }]);
    expect(merged.find((b) => b.key === "c_new")).toBeTruthy();
    expect(merged.find((b) => b.key === "needs_shoot")?.active).toBe(false);
  });
});

describe("0074 seed matches PRESET_BUCKETS", () => {
  it("seeds the same four presets", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "0074_studio_buckets.sql"), "utf8");
    for (const b of PRESET_BUCKETS) expect(sql).toContain(`('${b.key}',`);
    for (const b of PRESET_BUCKETS) expect(sql).toContain(`'${b.label}'`);
  });
});
