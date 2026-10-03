// Studio buckets (0074): staff-set work queues on a design — Needs Shoot,
// Needs Reshoot, Copy regeneration needed, Verified - all good, plus any
// custom bucket staff add from the dropdown. A label for people, never an
// input to deriveBadge, the publish gates or Shopify.
//
// Pure rules only; the table reads and writes live in the Studio actions.

export interface StudioBucket {
  key: string;
  label: string;
  sort: number;
  preset: boolean;
  /** false = removed from the dropdown; designs already in it keep it. */
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

// Words the dropdown already uses for itself — a bucket by one of these names
// would read as a second "Not set" or a second "Add custom" entry.
const RESERVED_LABELS = ["Not set", "Not set (clear)", "Set bucket…", "Set bucket...", "+ Add custom…", "Add custom"];

/** What staff typed, tidied: trimmed, inner runs of spaces collapsed. */
export function cleanBucketLabel(raw: string | null | undefined): { ok: true; label: string } | { ok: false; error: string } {
  const label = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!label) return { ok: false, error: "Type a name for the bucket." };
  if (label.length > BUCKET_LABEL_MAX) return { ok: false, error: `Keep the name under ${BUCKET_LABEL_MAX + 1} characters.` };
  if (RESERVED_LABELS.some((r) => sameBucketLabel(r, label))) return { ok: false, error: `"${label}" is already part of the dropdown — pick a different name.` };
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
 * Options for a design's dropdown: every active bucket, plus the design's own
 * bucket if it has since been removed — or is missing from the list entirely —
 * because a select must be able to show the value it holds (otherwise it reads
 * "Not set" and picking Not set would not even fire a change).
 */
export function dropdownBuckets(all: StudioBucket[], current: string | null): StudioBucket[] {
  const list = all.filter((b) => b.active || b.key === current);
  if (current && !all.some((b) => b.key === current)) list.push(orphan(current));
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

/** Merge locally added/changed buckets over the server list; local wins by key. */
export function mergeBuckets(server: StudioBucket[], local: StudioBucket[]): StudioBucket[] {
  const byKey = new Map(server.map((b) => [b.key, b]));
  for (const b of local) byKey.set(b.key, b);
  return sortBuckets([...byKey.values()]);
}
