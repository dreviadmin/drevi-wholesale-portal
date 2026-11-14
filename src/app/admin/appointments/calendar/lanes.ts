// Side-by-side lanes for the week grid: bookings that overlap share the
// column width; one alone gets all of it. Pure, so it is unit-tested.

/** Side-by-side lanes for bookings that overlap: each gets its lane and how many lanes its group has. */
export function lanes(list: Array<{ id: string; s: number; e: number }>): Map<string, { i: number; n: number }> {
  const sorted = [...list].sort((a, b) => a.s - b.s || a.e - b.e || a.id.localeCompare(b.id));
  const out = new Map<string, { i: number; n: number }>();
  let group: Array<{ id: string; lane: number }> = [], ends: number[] = [], groupEnd = -1;
  const flush = () => { for (const g of group) out.set(g.id, { i: g.lane, n: ends.length }); group = []; ends = []; };
  for (const x of sorted) {
    if (x.s >= groupEnd) { flush(); groupEnd = -1; }
    let lane = ends.findIndex((end) => end <= x.s);
    if (lane < 0) { lane = ends.length; ends.push(x.e); } else ends[lane] = x.e;
    group.push({ id: x.id, lane });
    groupEnd = Math.max(groupEnd, x.e);
  }
  flush();
  return out;
}
