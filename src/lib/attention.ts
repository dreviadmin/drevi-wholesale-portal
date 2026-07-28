import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { formatINR } from "@/lib/format";
import { reconcile } from "@/lib/stock-ledger";

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

  // 4. Failed pipeline jobs — a dead run blocks a design silently otherwise.
  try {
    const { count: failedJobs } = await admin
      .from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "error");
    if ((failedJobs ?? 0) > 0) {
      items.push({
        key: "pipeline_failed",
        title: `Pipeline: ${failedJobs} failed job${failedJobs === 1 ? "" : "s"}`,
        sub: "Open the board's job strip for logs",
        count: failedJobs ?? 0,
        severity: "high",
        href: "/admin/studio",
      });
    }
  } catch { /* table not migrated yet */ }

  // Retrofit §10.3 — "N SKUs need a stock check": the ledger and the cached
  // quantity disagree. Anything sold through Shopify POS is invisible here
  // (ANSH-18), so this is expected to be non-zero and is the honest surface
  // for it rather than a number nobody trusts.
  try {
    const { drift } = await reconcile();
    if (drift.length > 0) {
      items.push({
        key: "stock_drift",
        title: `${drift.length} SKU${drift.length === 1 ? "" : "s"} need a stock check`,
        sub: "The movement ledger and the cached quantity disagree",
        count: drift.length,
        severity: "medium",
        href: "/admin/stock-check",
      });
    }
  } catch { /* ledger not migrated yet */ }

  // Retrofit §6.3 — specs queue, missing ident photos, stale supply data.
  try {
    const staleDays = Number(process.env.SUPPLY_STALE_DAYS ?? 60);
    const staleBefore = new Date(Date.now() - staleDays * 86_400_000).toISOString();
    const [{ count: awaitingSpecs }, { count: noIdent }, { data: staleSupply }] = await Promise.all([
      admin.from("designs").select("id", { count: "exact", head: true }).eq("specs_verified", false),
      admin.from("designs").select("id", { count: "exact", head: true }).is("ident_image_id", null),
      admin
        .from("designs")
        .select("id, supply_updated_at, supply_mode")
        .in("supply_mode", ["made_to_order", "both"])
        .or(`supply_updated_at.is.null,supply_updated_at.lt.${staleBefore}`),
    ]);
    if ((awaitingSpecs ?? 0) > 0) {
      items.push({
        key: "designs_awaiting_specs",
        title: `${awaitingSpecs} design${awaitingSpecs === 1 ? "" : "s"} awaiting specs`,
        sub: "Fabric, handwork and origin — then Confirmed by Rakesh",
        count: awaitingSpecs ?? 0,
        severity: "medium",
        href: "/admin/studio?state=awaiting_specs",
      });
    }
    if ((noIdent ?? 0) > 0) {
      items.push({
        key: "designs_no_ident",
        title: `${noIdent} design${noIdent === 1 ? "" : "s"} without an ident photo`,
        sub: "A hanging shot makes the garment recognisable everywhere",
        count: noIdent ?? 0,
        severity: "low",
        href: "/admin/studio",
      });
    }
    const stale = (staleSupply ?? []).length;
    if (stale > 0) {
      items.push({
        key: "supply_stale",
        title: `${stale} made-to-order design${stale === 1 ? "" : "s"} with old supply info`,
        sub: `Lead times older than ${staleDays} days — re-ask the vendor`,
        count: stale,
        severity: "medium",
        href: "/admin/studio?supply=stale",
      });
    }
  } catch { /* retrofit columns absent — nothing to report */ }

  // 3. Studio: designs stuck before the camera or waiting on a reviewer.
  try {
    const { loadBoard } = await import("@/lib/studio/load");
    const board = await loadBoard();
    const needsPhotos = board.filter((b) => b.badge === "needs_photos").length;
    const inReview = board.filter((b) => b.badge === "in_review").length;
    if (needsPhotos > 0) {
      items.push({
        key: "studio_needs_photos",
        title: `${needsPhotos} design${needsPhotos === 1 ? "" : "s"} awaiting photos`,
        sub: "Specs verified · ready for the pipeline",
        count: needsPhotos,
        severity: "medium",
        href: "/admin/studio?state=needs_photos",
      });
    }
    if (inReview > 0) {
      items.push({
        key: "studio_in_review",
        title: `${inReview} design${inReview === 1 ? "" : "s"} need photo review`,
        sub: "Candidates waiting for approval",
        count: inReview,
        severity: "medium",
        href: "/admin/studio?state=in_review",
      });
    }
  } catch { /* studio tables not migrated yet — zero-count gracefully */ }

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
