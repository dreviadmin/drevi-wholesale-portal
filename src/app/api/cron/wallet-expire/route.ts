import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";
import { postMovement, reconcileRecent } from "@/lib/wallet";
import { eachSettled } from "@/lib/wallet-core";
import { deleteDiscount } from "@/lib/wallet-shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The reconciliation reads up to a few hundred orders from Shopify.
export const maxDuration = 60;

// Nightly sweep for wallets whose twelve months have run out. Reads already
// lapse a wallet lazily (sweepExpiry), so this is for the ones nobody has
// looked at — the statement should show the expiry on the day it happened,
// not on the day the customer next logged in. Vercel cron, see vercel.json.
//
// Then it tidies ended wallet discounts out of Shopify, and last it checks
// the last 72 hours of orders against the ledger (reconcileRecent). Each step
// runs even when the one before it failed: one bad wallet does not stop the
// others, and a reconciliation that throws does not undo the sweep.

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${getEnv("CRON_SECRET")}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("wallet_accounts")
    .select("id, balance_paise, expires_at")
    .gt("balance_paise", 0)
    .lte("expires_at", new Date().toISOString())
    .limit(500);
  if (error) console.error("[wallet-expire] read wallets:", error.message);

  const lapse = await eachSettled(
    (data ?? []) as Array<{ id: string; balance_paise: number; expires_at: string }>,
    async (a) => !!(await postMovement({ accountId: a.id, kind: "expire", amountPaise: -a.balance_paise, refType: "expiry", refId: a.expires_at, clamp: true, note: "Lapsed after 12 months without a credit" })),
    (a, e) => console.error(`[wallet-expire] ${a.id}:`, (e as Error).message),
  );

  // Tidy Shopify: wallet discounts whose reservation has ended (Shopify has
  // already stopped applying them at endsAt) and any a void left behind, so
  // the Discounts list doesn't fill up with dead "Drevi Wallet" entries.
  const now = new Date().toISOString();
  const { data: stale } = await admin.from("wallet_redemptions").select("id, status, shopify_discount_id")
    .in("status", ["open", "expired", "void"]).lt("expires_at", now).not("shopify_discount_id", "is", null).limit(200);
  let tidied = 0;
  for (const r of (stale ?? []) as Array<{ id: string; status: string; shopify_discount_id: string }>) {
    try {
      await deleteDiscount(r.shopify_discount_id);
      await admin.from("wallet_redemptions").update({ shopify_discount_id: null, ...(r.status === "open" ? { status: "expired" } : {}) }).eq("id", r.id);
      tidied++;
    } catch (e) {
      console.warn("[wallet-expire] discount cleanup:", (e as Error).message);
    }
  }

  // Orders against the ledger. It only reports and tags; it never posts.
  let reconcile: Awaited<ReturnType<typeof reconcileRecent>> | { ok: false; error: string };
  try {
    reconcile = await reconcileRecent();
  } catch (e) {
    console.error("[wallet-reconcile] failed:", (e as Error).message);
    reconcile = { ok: false, error: (e as Error).message.slice(0, 200) };
  }

  const ok = !error && lapse.failed === 0;
  return NextResponse.json(
    { ok, expired: lapse.done, failed: lapse.failed, tidied, reconcile, ...(error ? { error: error.message } : {}), at: new Date().toISOString() },
    { status: ok ? 200 : 500 },
  );
}
