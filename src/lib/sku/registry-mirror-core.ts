// Which pending portal rows the SKU-registry mirror appends to the legacy sheet
// (pure, so it can be tested without Google or Supabase).
//
// The mirror runs every 10 minutes (vercel.json) and again whenever GitHub's
// backstop run lands, and Vercel can deliver one scheduled run twice. Two runs
// reading the same pending rows used to append them twice. So, before appending:
//   - a row minted in the last MIRROR_MIN_AGE_MS is left to the inline mirror
//     (mirrorOne runs straight after the mint and takes a few seconds);
//   - a row whose variant SKU is already on the sheet is only marked as synced,
//     never appended again. This also covers a run that appended but stopped
//     before it could mark the rows.

export const MIRROR_MIN_AGE_MS = 2 * 60 * 1000;

export interface PendingRow { id: string; variant_sku: string; created_at: string }

export interface MirrorPlan<R extends PendingRow> {
  /** Not on the sheet yet: append, then mark as synced. */
  append: R[];
  /** Already on the sheet: mark as synced without appending. */
  alreadyOnSheet: R[];
  /** Too new: the inline mirror is probably still writing it. */
  tooNew: R[];
}

export function planMirror<R extends PendingRow>(pending: R[], sheetVariants: Iterable<string>, now: number, minAgeMs = MIRROR_MIN_AGE_MS): MirrorPlan<R> {
  const onSheet = new Set<string>();
  for (const v of sheetVariants) if (v) onSheet.add(v.trim().toUpperCase());
  const plan: MirrorPlan<R> = { append: [], alreadyOnSheet: [], tooNew: [] };
  for (const r of pending) {
    const created = new Date(r.created_at).getTime();
    if (Number.isFinite(created) && now - created < minAgeMs) plan.tooNew.push(r);
    else if (onSheet.has(r.variant_sku.trim().toUpperCase())) plan.alreadyOnSheet.push(r);
    else plan.append.push(r);
  }
  return plan;
}
