import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { formatINR } from "@/lib/format";

// "Needs you" inbox (build guide §6.4) — ordered by cost of inaction. Used by
// both the Home cockpit (server render) and GET /api/home/attention. Each item
// deep-links with its target filter pre-applied. Studio/pipeline sources
// return zero-count gracefully until Stages 3–4 ship their tables.

export interface AttentionItem {
  key: string;
  title: string;
  sub: string;
  count: number;
  severity: "high" | "medium" | "low";
  href: string;
}

export async function computeAttention(): Promise<AttentionItem[]> {
  const admin = createAdminClient();

  const [submitted, pendingBuyers, soldOutBest, orderedItems] = await Promise.all([
    // 1. Money-blocking: submitted orders whose balance hasn't been collected.
    admin
      .from("orders")
      .select("id, total_amount, advance_amount")
      .eq("status", "submitted"),
    // 2. Buyers waiting for approval.
    admin.from("buyers").select("id", { count: "exact", head: true }).eq("status", "pending"),
    // 5. Sold-out BEST-SELLERS: sold out AND actually ordered at least once —
    //    the whole catalog being qty-0 must not flood the inbox.
    admin.from("wholesale_products").select("sku").lte("current_qty", 0).eq("wholesale_visible", true),
    admin.from("orders").select("items").neq("status", "cancelled"),
  ]);
  const orderedSkus = new Set<string>();
  for (const o of orderedItems.data ?? []) {
    for (const it of (o.items as { sku?: string }[] | null) ?? []) {
      if (it.sku) orderedSkus.add(it.sku.toUpperCase());
    }
  }

  const items: AttentionItem[] = [];

  const subs = submitted.data ?? [];
  if (subs.length > 0) {
    const due = subs.reduce((s, o) => s + Math.max(0, (o.total_amount ?? 0) - (o.advance_amount ?? 0)), 0);
    items.push({
      key: "orders_submitted",
      title: `${subs.length} order${subs.length === 1 ? "" : "s"} awaiting confirmation`,
      sub: `${formatINR(due)} balance uncollected`,
      count: subs.length,
      severity: "high",
      href: "/admin/orders?status=submitted",
    });
  }

  const pending = pendingBuyers.count ?? 0;
  if (pending > 0) {
    items.push({
      key: "buyers_pending",
      title: `${pending} buyer${pending === 1 ? "" : "s"} pending approval`,
      sub: "They can't order until approved",
      count: pending,
      severity: "medium",
      href: "/admin/buyers?status=pending",
    });
  }

  // 3/4. Studio + pipeline sources arrive with Stages 3–4; zero-count now.

  const soldOut = (soldOutBest.data ?? []).filter((p) => orderedSkus.has(p.sku.toUpperCase())).length;
  if (soldOut > 0) {
    items.push({
      key: "reorder_soldout",
      title: `${soldOut} best-seller${soldOut === 1 ? "" : "s"} sold out`,
      sub: "Review the reorder table",
      count: soldOut,
      severity: "low",
      href: "/admin/reorder",
    });
  }

  return items;
}

// Today's money (IST) — the cockpit header numbers, same definitions as the
// dashboard: sales = non-cancelled orders submitted today; pieces = billed qty.
export interface TodayMetrics {
  sales: number;
  orders: number;
  pieces: number;
  advanceIn: number;
  balanceDue: number;
}

export async function computeToday(): Promise<TodayMetrics> {
  const admin = createAdminClient();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // IST midnight in UTC — submitted_at is timestamptz.
  const startUtc = new Date(`${today}T00:00:00+05:30`).toISOString();
  const { data } = await admin
    .from("orders")
    .select("total_amount, advance_amount, items, status")
    .gte("submitted_at", startUtc)
    .neq("status", "cancelled");
  let sales = 0, pieces = 0, advanceIn = 0, balanceDue = 0;
  for (const o of data ?? []) {
    sales += o.total_amount ?? 0;
    advanceIn += o.advance_amount ?? 0;
    balanceDue += Math.max(0, (o.total_amount ?? 0) - (o.advance_amount ?? 0));
    for (const it of (o.items as { qty?: number }[] | null) ?? []) pieces += it.qty ?? 0;
  }
  return { sales, orders: (data ?? []).length, pieces, advanceIn, balanceDue };
}
