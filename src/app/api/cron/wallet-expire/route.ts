import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEnv } from "@/lib/env";
import { postMovement } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nightly sweep for wallets whose twelve months have run out. Reads already
// lapse a wallet lazily (sweepExpiry), so this is for the ones nobody has
// looked at — the statement should show the expiry on the day it happened,
// not on the day the customer next logged in. Vercel cron, see vercel.json.

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
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  let expired = 0;
  for (const a of (data ?? []) as Array<{ id: string; balance_paise: number; expires_at: string }>) {
    const row = await postMovement({ accountId: a.id, kind: "expire", amountPaise: -a.balance_paise, refType: "expiry", refId: a.expires_at, clamp: true, note: "Lapsed after 12 months without a credit" });
    if (row) expired++;
  }
  return NextResponse.json({ ok: true, expired, at: new Date().toISOString() });
}
