import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/staff";
import { reconcile } from "@/lib/stock-ledger";

export const dynamic = "force-dynamic";

// Retrofit R8 §10.3 — drift report. Compares the canonical ledger value
// against the cached wholesale_products.current_qty per SKU and lists the
// mismatches with each SKU's last five movements and its most recent reset.
//
// The honest gap (§10.4): until a Shopify sync exists, anything sold through
// Shopify POS is invisible here, so Supabase will read HIGH. That is exactly
// what this report is for — a stock take corrects it, guessing does not.
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const result = await reconcile();
  return NextResponse.json(result);
}
