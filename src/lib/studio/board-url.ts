// The Studio board's view in its URL: the filter chips, the search text, the
// column sort and Show discontinued. The board writes it into its own address
// and hands it to every design it opens, so both the page's Back link and the
// browser's (or a phone's swipe) land on the same list. Pure, so the round
// trip is pinned by vitest.

import { BADGE_LABEL, type DesignBadge } from "./state";
import { MISSING_FIELDS, isMissingKey, type MissingKey } from "./missing";
import { BUCKET_NONE } from "./buckets";

/** The board's sortable columns: the accessor names StudioBoard hands useSort. */
export const BOARD_SORT_KEYS = ["sku", "title", "badge", "photos", "tier", "bucket", "added"] as const;

export interface BoardSort { key: string; dir: "asc" | "desc" }
/** Newest first. Left out of the URL, so a plain /admin/studio means this. */
export const DEFAULT_BOARD_SORT: BoardSort = { key: "added", dir: "desc" };

export type SpecsFilter = "any" | "confirmed" | "awaiting";

export interface BoardView {
  chip: DesignBadge | "all";
  specs: SpecsFilter;
  photos: ReadonlySet<number>;
  missing: ReadonlySet<MissingKey>;
  buckets: ReadonlySet<string>;
  query: string;
  sort: BoardSort;
  showDiscontinued: boolean;
}

/** A search longer than this is a paste gone wrong, not a SKU. */
const QUERY_MAX = 100;

const isBadge = (s: string): s is DesignBadge => Object.prototype.hasOwnProperty.call(BADGE_LABEL, s);
const isSortKey = (s: string) => (BOARD_SORT_KEYS as readonly string[]).includes(s);
const isBucketToken = (k: string) => k === BUCKET_NONE || /^[a-z0-9_]{1,48}$/.test(k);
const list = (v: string | null) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

/** The query string for a view, without the "?"; empty for the default board. */
export function boardQuery(v: BoardView): string {
  const p = new URLSearchParams();
  if (v.chip !== "all") p.set("state", v.chip);
  if (v.specs !== "any") p.set("specs", v.specs);
  if (v.photos.size > 0) p.set("photos", [...v.photos].sort((a, b) => a - b).join(","));
  if (v.missing.size > 0) p.set("missing", MISSING_FIELDS.filter((f) => v.missing.has(f.key)).map((f) => f.key).join(","));
  if (v.buckets.size > 0) p.set("bucket", [...v.buckets].sort().join(","));
  const q = v.query.trim().slice(0, QUERY_MAX);
  if (q) p.set("q", q);
  if (isSortKey(v.sort.key) && (v.sort.key !== DEFAULT_BOARD_SORT.key || v.sort.dir !== DEFAULT_BOARD_SORT.dir)) {
    p.set("sort", v.sort.key);
    p.set("dir", v.sort.dir);
  }
  if (v.showDiscontinued) p.set("disc", "1");
  return p.toString();
}

/** The board's address for a view. */
export function boardPath(v: BoardView): string {
  const q = boardQuery(v);
  return q ? `/admin/studio?${q}` : "/admin/studio";
}

/**
 * Read a view back. Anything unknown or malformed falls back to the default
 * for that part alone, so a stale or hand-edited link still opens the board.
 */
export function parseBoardQuery(params: URLSearchParams): BoardView {
  const state = params.get("state") ?? "";
  const specs = params.get("specs");
  const sortKey = params.get("sort") ?? "";
  const dir = params.get("dir");
  return {
    chip: isBadge(state) ? state : "all",
    specs: specs === "confirmed" || specs === "awaiting" ? specs : "any",
    photos: new Set(list(params.get("photos")).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)),
    missing: new Set(list(params.get("missing")).filter(isMissingKey)),
    buckets: new Set(list(params.get("bucket")).filter(isBucketToken)),
    query: (params.get("q") ?? "").trim().slice(0, QUERY_MAX),
    sort: isSortKey(sortKey) && (dir === "asc" || dir === "desc") ? { key: sortKey, dir } : DEFAULT_BOARD_SORT,
    showDiscontinued: params.get("disc") === "1",
  };
}
