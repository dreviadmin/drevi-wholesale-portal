import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUCKET_NONE,
  PRESET_BUCKETS,
  applyBucketChange,
  bucketChanges,
  bucketKeyFor,
  bucketLabel,
  bucketMarks,
  bucketSummary,
  cleanBucketLabel,
  countBuckets,
  filterBuckets,
  inBucketFilter,
  mergeBuckets,
  orderedBucketKeys,
  pickerBuckets,
  sameBucketKeys,
  sameBucketLabel,
  type BucketMark,
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

describe("pickerBuckets", () => {
  const all = [...PRESET_BUCKETS, custom("c_old", "Old", false), custom("c_new", "New")];
  it("offers active buckets in order", () => {
    expect(pickerBuckets(all).map((b) => b.key)).toEqual(["needs_shoot", "needs_reshoot", "copy_regen", "verified", "c_new"]);
  });
  it("keeps a removed bucket only for the design that holds it, so it can be taken off", () => {
    expect(pickerBuckets(all, ["c_old", "verified"]).map((b) => b.key)).toContain("c_old");
    expect(pickerBuckets(all, ["verified"]).map((b) => b.key)).not.toContain("c_old");
  });
  it("shows a key missing from the list instead of hiding it", () => {
    expect(pickerBuckets(PRESET_BUCKETS, ["c_hold"]).map((b) => b.key)).toContain("c_hold");
  });
});

describe("several buckets per design (0078)", () => {
  const all = [...PRESET_BUCKETS, custom("c_steam", "Steam")];
  it("lists and names a design's buckets in picker order, whatever order they were added", () => {
    expect(orderedBucketKeys(["c_steam", "verified", "needs_shoot"], all)).toEqual(["needs_shoot", "verified", "c_steam"]);
    expect(bucketSummary(["c_steam", "needs_shoot"], all)).toBe("Needs Shoot, Steam");
    expect(bucketSummary([], all)).toBe("Not set");
  });
  it("filters OR'd across buckets, with Not set meaning in none", () => {
    expect(inBucketFilter(["needs_shoot", "copy_regen"], new Set())).toBe(true);
    expect(inBucketFilter(["needs_shoot", "copy_regen"], new Set(["copy_regen"]))).toBe(true);
    expect(inBucketFilter(["needs_shoot"], new Set(["copy_regen", "verified"]))).toBe(false);
    expect(inBucketFilter([], new Set([BUCKET_NONE]))).toBe(true);
    expect(inBucketFilter(["needs_shoot"], new Set([BUCKET_NONE]))).toBe(false);
    expect(inBucketFilter([], new Set(["needs_shoot"]))).toBe(false);
  });
  it("counts a design under every bucket it is in, and Not set only when in none", () => {
    const c = countBuckets([{ buckets: ["needs_shoot", "copy_regen"] }, { buckets: ["copy_regen"] }, { buckets: [] }, { buckets: ["copy_regen", "copy_regen"] }]);
    expect(c.get("needs_shoot")).toBe(1);
    expect(c.get("copy_regen")).toBe(3);
    expect(c.get(BUCKET_NONE)).toBe(1);
  });
  it("compares bucket lists as sets", () => {
    expect(sameBucketKeys(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameBucketKeys(["a"], ["a", "b"])).toBe(false);
    expect(sameBucketKeys([], [])).toBe(true);
  });
  it("applies a change the way the server does", () => {
    expect(applyBucketChange(["needs_shoot"], { add: ["copy_regen"] })).toEqual(["needs_shoot", "copy_regen"]);
    expect(applyBucketChange(["needs_shoot", "copy_regen"], { remove: ["needs_shoot"] })).toEqual(["copy_regen"]);
    expect(applyBucketChange(["needs_shoot"], { add: ["needs_shoot"] })).toEqual(["needs_shoot"]);
    expect(applyBucketChange(["needs_shoot", "verified"], { clear: true })).toEqual([]);
    expect(applyBucketChange(["needs_shoot"], { clear: true, add: ["verified"] })).toEqual(["verified"]);
  });
});

describe("batch picker marks and Apply", () => {
  const selected = [{ buckets: ["needs_shoot", "copy_regen"] }, { buckets: ["needs_shoot"] }, { buckets: [] }];
  it("marks each bucket all, some or none across the selection", () => {
    const m = bucketMarks(selected, ["needs_shoot", "copy_regen", "verified"]);
    expect(m.get("needs_shoot")).toBe("some");
    expect(m.get("copy_regen")).toBe("some");
    expect(m.get("verified")).toBe("none");
    expect(bucketMarks([{ buckets: ["verified"] }, { buckets: ["verified"] }], ["verified"]).get("verified")).toBe("all");
  });
  it("adds and removes only what staff changed, leaving mixed buckets alone", () => {
    const initial = new Map<string, BucketMark>([["needs_shoot", "some"], ["copy_regen", "some"], ["verified", "none"], ["c_steam", "all"]]);
    const chosen = new Map<string, BucketMark>([["needs_shoot", "all"], ["copy_regen", "some"], ["verified", "all"], ["c_steam", "none"]]);
    expect(bucketChanges(initial, chosen)).toEqual({ add: ["needs_shoot", "verified"], remove: ["c_steam"] });
    expect(bucketChanges(initial, initial)).toEqual({ add: [], remove: [] });
  });
  it("treats a bucket created in the picker as new to every design", () => {
    expect(bucketChanges(new Map(), new Map([["c_new", "all" as BucketMark]]))).toEqual({ add: ["c_new"], remove: [] });
  });
  it("can take every design out of a mixed bucket", () => {
    expect(bucketChanges(new Map([["needs_shoot", "some" as BucketMark]]), new Map([["needs_shoot", "none" as BucketMark]]))).toEqual({ add: [], remove: ["needs_shoot"] });
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

describe("0078 carries 0074's buckets across once", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "0078_design_buckets.sql"), "utf8");
  it("copies only in the run that creates the table, so a replay cannot put back buckets staff took off", () => {
    const block = sql.slice(sql.indexOf("do $$"), sql.indexOf("end $$;"));
    expect(block).toContain("if to_regclass('public.design_buckets') is null then");
    expect(block).toContain("create table design_buckets");
    expect(block).toContain("insert into design_buckets");
    expect(sql).not.toMatch(/not exists \(select 1 from design_buckets\)/);
    expect(sql.match(/insert into design_buckets/g)).toHaveLength(1);
  });
  it("keeps RLS on with no policies", () => {
    expect(sql).toContain("alter table design_buckets enable row level security");
    expect(sql).not.toMatch(/create policy/i);
  });
});

describe("0074 seed matches PRESET_BUCKETS", () => {
  it("seeds the same four presets", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "0074_studio_buckets.sql"), "utf8");
    for (const b of PRESET_BUCKETS) expect(sql).toContain(`('${b.key}',`);
    for (const b of PRESET_BUCKETS) expect(sql).toContain(`'${b.label}'`);
  });
});
