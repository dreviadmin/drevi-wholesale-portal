import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

// PostgREST silently caps un-ranged selects at 1000 rows — a full sku_registry
// backfill or months of receipt lines would quietly truncate counters, the
// bases picker and Last-GR-Cost. This pages through .range() until exhausted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic row payloads from dynamic tables
export async function fetchAll<T = any>(
  client: SupabaseClient,
  table: string,
  columns: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST filter builder passthrough
  apply?: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = client.from(table).select(columns).range(from, from + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
