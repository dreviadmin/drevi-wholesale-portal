import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// fetch-all.ts is server-only; the marker package throws outside a React
// Server Component and has nothing to exercise, so it is stubbed.
vi.mock("server-only", () => ({}));

import { fetchAll } from "./fetch-all";

// The server's own cap: PostgREST hands back at most this many rows per
// request, whatever range was asked for.
const MAX_ROWS = 1000;

interface Call { table: string; columns: string; from: number; to: number; ops: string[] }

/**
 * A stand-in for the Supabase client that serves `total` rows ({ id: 0..n-1 })
 * the way PostgREST does: the asked-for range, cut to MAX_ROWS. Filters and
 * sorts are recorded, not applied. `failFrom` makes the page starting at that
 * offset come back as an error.
 */
function fakeClient(total: number, opts: { failFrom?: number } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            range(from: number, to: number) {
              const call: Call = { table, columns, from, to, ops: [] };
              calls.push(call);
              const builder = {
                order(col: string) { call.ops.push(`order:${col}`); return builder; },
                eq(col: string, v: unknown) { call.ops.push(`eq:${col}=${String(v)}`); return builder; },
                then<R>(resolve: (v: { data: { id: number }[] | null; error: { message: string } | null }) => R) {
                  if (opts.failFrom === from) return Promise.resolve(resolve({ data: null, error: { message: "boom" } }));
                  const n = Math.max(0, Math.min(to - from + 1, MAX_ROWS, total - from));
                  return Promise.resolve(resolve({ data: Array.from({ length: n }, (_, i) => ({ id: from + i })), error: null }));
                },
              };
              return builder;
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchAll", () => {
  it("returns every row past the 1,000-row cap, in order, with no repeats", async () => {
    const { client, calls } = fakeClient(2500);
    const rows = await fetchAll<{ id: number }>(client, "orders", "id");
    expect(rows).toHaveLength(2500);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
    expect(calls.map((c) => [c.from, c.to])).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("stops after one empty page when the count is an exact multiple of a page", async () => {
    const { client, calls } = fakeClient(2000);
    const rows = await fetchAll(client, "orders", "id");
    expect(rows).toHaveLength(2000);
    expect(calls).toHaveLength(3);
  });

  it("reads once for a small table and once for an empty one", async () => {
    const small = fakeClient(7);
    expect(await fetchAll(small.client, "agents", "*")).toHaveLength(7);
    expect(small.calls).toHaveLength(1);
    const empty = fakeClient(0);
    expect(await fetchAll(empty.client, "agents", "*")).toEqual([]);
    expect(empty.calls).toHaveLength(1);
  });

  it("applies the caller's filters and sort to every page", async () => {
    const { client, calls } = fakeClient(1500);
    await fetchAll(client, "wholesale_products", "sku", (q) => q.eq("buyer_visible", true).order("title").order("sku"));
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.table).toBe("wholesale_products");
      expect(c.columns).toBe("sku");
      expect(c.ops).toEqual(["eq:buyer_visible=true", "order:title", "order:sku"]);
    }
  });

  it("throws, naming the table, when a page fails, rather than returning a short list", async () => {
    const { client } = fakeClient(2500, { failFrom: 1000 });
    await expect(fetchAll(client, "buyers", "id")).rejects.toThrow("buyers read failed: boom");
  });
});
