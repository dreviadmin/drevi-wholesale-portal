// Studio buckets (0074): staff-set work queues on a design — Needs Shoot,
// Needs Reshoot, Copy regeneration needed, Verified - all good, plus any
// custom bucket staff add from the picker. A label for people, never an
// input to deriveBadge, the publish gates or Shopify.
//
// Since 0078 a design can be in several buckets at once (design_buckets), so
// a design's buckets are a list of keys and an empty list is "Not set".
//
// Pure rules only; the table reads and writes live in the Studio actions.

export interface StudioBucket {
  key: string;
  label: string;
  sort: number;
  preset: boolean;
  /** false = removed from the picker; designs already in it keep it. */
  active: boolean;
}

/** Same rows 0074 seeds — the fallback if the table cannot be read. */
export const PRESET_BUCKETS: StudioBucket[] = [
  { key: "needs_shoot", label: "Needs Shoot", sort: 10, preset: true, active: true },
  { key: "needs_reshoot", label: "Needs Reshoot", sort: 20, preset: true, active: true },
  { key: "copy_regen", label: "Copy regeneration needed", sort: 30, preset: true, active: true },
  { key: "verified", label: "Verified - all good", sort: 40, preset: true, active: true },
];

/**
 * The filter's "Not set" token, in URLs and filter state. Custom keys always
 * start "c_" and presets are fixed, so no bucket key can ever equal it.
 */
export const BUCKET_NONE = "none";

export const BUCKET_LABEL_MAX = 40;

// Words the picker already uses for itself — a bucket by one of these names
// would read as a second "Not set" or a second "Add custom" entry.
const RESERVED_LABELS = ["Not set", "Not set (clear)", "Set bucket…", "Set bucket...", "Buckets…", "Buckets...", "Clear all", "+ Add custom…", "Add custom"];

/** What staff typed, tidied: trimmed, inner runs of spaces collapsed. */
export function cleanBucketLabel(raw: string | null | undefined): { ok: true; label: string } | { ok: false; error: string } {
  const label = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!label) return { ok: false, error: "Type a name for the bucket." };
  if (label.length > BUCKET_LABEL_MAX) return { ok: false, error: `Keep the name under ${BUCKET_LABEL_MAX + 1} characters.` };
  if (RESERVED_LABELS.some((r) => sameBucketLabel(r, label))) return { ok: false, error: `"${label}" is already used by the bucket picker — pick a different name.` };
  return { ok: true, label };
}

/** One bucket per name, whatever the capitals or spacing (mirrors the 0074 index). */
export function sameBucketLabel(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A stable key for a new custom bucket: "c_" + a slug of the label, numbered
 * if taken. The prefix keeps custom keys clear of the presets and of
 * BUCKET_NONE; a label with no Latin letters (e.g. Hindi) slugs to "bucket".
 * Always matches the 0074 key shape ^[a-z0-9_]{1,48}$.
 */
export function bucketKeyFor(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "bucket";
  const base = `c_${slug}`;
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const key = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!used.has(key)) return key;
  }
}

export function sortBuckets(list: StudioBucket[]): StudioBucket[] {
  return [...list].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
}

/**
 * Options for a design's picker: every active bucket, plus any bucket the
 * design (or, in the batch picker, any selected design) is in that has since
 * been removed or is missing from the list entirely. A checklist that hid a
 * held bucket could never take it off.
 */
export function pickerBuckets(all: StudioBucket[], held: Iterable<string> = []): StudioBucket[] {
  const heldSet = new Set(held);
  const list = all.filter((b) => b.active || heldSet.has(b.key));
  for (const key of heldSet) if (!all.some((b) => b.key === key)) list.push(orphan(key));
  return sortBuckets(list);
}

function orphan(key: string): StudioBucket {
  return { key, label: key, sort: 10_000, preset: false, active: false };
}

/**
 * Chips for the board filter: every active bucket (a new one shows the moment
 * it exists, at zero), plus any removed bucket that designs still sit in. A
 * design whose key is not in the list at all still gets a chip, labelled by
 * its key, so no design can become unfindable. Anything currently SELECTED
 * keeps its chip too — a filter that is on must always be visible, and
 * clickable to turn off (a URL key, or a bucket removed while filtered).
 */
export function filterBuckets(all: StudioBucket[], counts: Map<string, number>, selected: Set<string> = new Set()): StudioBucket[] {
  const known = new Set(all.map((b) => b.key));
  const orphans: StudioBucket[] = [...new Set([...counts.keys(), ...selected])]
    .filter((k) => k !== BUCKET_NONE && !known.has(k))
    .map(orphan);
  return sortBuckets([...all.filter((b) => b.active || (counts.get(b.key) ?? 0) > 0 || selected.has(b.key)), ...orphans]);
}

export function bucketLabel(key: string | null, all: StudioBucket[]): string {
  if (!key) return "Not set";
  return all.find((b) => b.key === key)?.label ?? key;
}

/** A design's buckets in the order the picker lists them, so every screen reads them alike. */
export function orderedBucketKeys(keys: Iterable<string>, all: StudioBucket[]): string[] {
  const rank = new Map(sortBuckets(all).map((b, i) => [b.key, i]));
  return [...new Set(keys)].sort((a, b) => (rank.get(a) ?? 1e6) - (rank.get(b) ?? 1e6) || a.localeCompare(b));
}

/** "Not set", or the labels in picker order. */
export function bucketSummary(keys: readonly string[], all: StudioBucket[]): string {
  if (keys.length === 0) return "Not set";
  return orderedBucketKeys(keys, all).map((k) => bucketLabel(k, all)).join(", ");
}

/**
 * Does a design in these buckets pass the board filter? OR'd, like every
 * other multi-select filter on the board: a design shows if it is in ANY
 * selected bucket. BUCKET_NONE matches a design in none.
 */
export function inBucketFilter(keys: readonly string[], filter: ReadonlySet<string>): boolean {
  if (filter.size === 0) return true;
  if (keys.length === 0) return filter.has(BUCKET_NONE);
  return keys.some((k) => filter.has(k));
}

/**
 * Designs per bucket, BUCKET_NONE for designs in none. A design in two buckets
 * counts under both, so the chips no longer add up to the board total.
 */
export function countBuckets(rows: { buckets: readonly string[] }[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const r of rows) {
    if (r.buckets.length === 0) c.set(BUCKET_NONE, (c.get(BUCKET_NONE) ?? 0) + 1);
    for (const k of new Set(r.buckets)) c.set(k, (c.get(k) ?? 0) + 1);
  }
  return c;
}

/** Same set of buckets, whatever the order. */
export function sameBucketKeys(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((k) => sb.has(k));
}

export interface BucketChange {
  add?: string[];
  remove?: string[];
  /** Take the designs out of every bucket first (then add, if any). */
  clear?: boolean;
}

/** What a change did, in the words both the board and the Workbench use. */
export function describeBucketChange(change: BucketChange, name: (key: string) => string): string {
  const parts = [
    change.clear && !change.add?.length ? "Buckets cleared" : "",
    change.add?.length ? `Added to ${change.add.map(name).join(", ")}` : "",
    change.remove?.length ? `Taken off ${change.remove.map(name).join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/** A bucket's name for a design that is in it: removed ones say so, unknown keys show the key. */
export function heldBucketName(key: string, all: StudioBucket[]): string {
  const b = all.find((x) => x.key === key);
  return b && b.active ? b.label : `${b?.label ?? key} (removed)`;
}

/** A design's buckets after a change, as the board shows it before the server answers. */
export function applyBucketChange(keys: readonly string[], change: BucketChange): string[] {
  const remove = new Set(change.remove ?? []);
  const kept = change.clear ? [] : keys.filter((k) => !remove.has(k));
  return [...new Set([...kept, ...(change.add ?? [])])];
}

/** In the batch picker: are all, some or none of the selected designs in a bucket? */
export type BucketMark = "all" | "some" | "none";

export function bucketMarks(selected: { buckets: readonly string[] }[], keys: Iterable<string>): Map<string, BucketMark> {
  const marks = new Map<string, BucketMark>();
  for (const key of keys) {
    const n = selected.filter((r) => r.buckets.includes(key)).length;
    marks.set(key, n === 0 ? "none" : n === selected.length ? "all" : "some");
  }
  return marks;
}

/**
 * What the batch picker's Apply has to do: only the buckets whose mark staff
 * changed. A bucket left at "some" is left alone, so applying never moves a
 * design that staff did not mean to touch.
 */
export function bucketChanges(initial: ReadonlyMap<string, BucketMark>, chosen: ReadonlyMap<string, BucketMark>): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [key, mark] of chosen) {
    if (mark === (initial.get(key) ?? "none")) continue;
    if (mark === "all") add.push(key);
    else if (mark === "none") remove.push(key);
  }
  return { add, remove };
}

/** Merge locally added/changed buckets over the server list; local wins by key. */
export function mergeBuckets(server: StudioBucket[], local: StudioBucket[]): StudioBucket[] {
  const byKey = new Map(server.map((b) => [b.key, b]));
  for (const b of local) byKey.set(b.key, b);
  return sortBuckets([...byKey.values()]);
}
