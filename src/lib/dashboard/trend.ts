import { addDays, daysBetween, fmtDay, fmtMonth, inBounds, lastDayOfMonth, weekStart, type Bounds } from "./dates";

export interface TrendBucket { from: string; to: string; label: string; amount: number }

const MAX_DAILY = 45;
const MAX_WEEKLY = 182;

/** Sales over the chosen days. Empty days stay in, or a quiet week would look busy. */
export function trendBuckets(points: { day: string; amount: number }[], bounds: Bounds | null, today: string): TrendBucket[] {
  const kept = points.filter((p) => inBounds(p.day, bounds));
  if (!bounds || !kept.length) return [];
  const days = kept.map((p) => p.day).sort();
  const from = bounds.from ?? days[0];
  const to = bounds.to ?? (today > days[days.length - 1] ? today : days[days.length - 1]);
  const span = daysBetween(from, to) + 1;
  if (span > 40000) return []; // no real range is this long; never spin on a bad bound

  const buckets: TrendBucket[] = [];
  if (span <= MAX_DAILY) {
    for (let d = from; d <= to; d = addDays(d, 1)) buckets.push({ from: d, to: d, label: fmtDay(d), amount: 0 });
  } else if (span <= MAX_WEEKLY) {
    for (let d = weekStart(from); d <= to; d = addDays(d, 7)) {
      // The first and last weeks stop at the chosen dates, so tapping one cannot widen them.
      const start = d < from ? from : d;
      const end = addDays(d, 6) > to ? to : addDays(d, 6);
      buckets.push({ from: start, to: end, label: `${fmtDay(start)} to ${fmtDay(end)}`, amount: 0 });
    }
  } else {
    for (let d = `${from.slice(0, 7)}-01`; d <= to; d = addDays(lastDayOfMonth(d), 1)) {
      buckets.push({ from: d < from ? from : d, to: lastDayOfMonth(d) > to ? to : lastDayOfMonth(d), label: fmtMonth(d), amount: 0 });
    }
  }
  for (const p of kept) {
    const hit = buckets.find((b) => p.day >= b.from && p.day <= b.to);
    if (hit) hit.amount += p.amount;
  }
  return buckets;
}
