import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react";
import { logout } from "@/app/actions";
import { createServerSupabase } from "@/lib/supabase/server";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { Order } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "Submitted",
  confirmed: "Confirmed",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

export default async function OrderHistoryPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS scopes to the buyer's own orders.
  const { data: orders } = await supabase
    .from("orders")
    .select("id, order_number, total_amount, status, submitted_at")
    .order("submitted_at", { ascending: false });

  const list = (orders ?? []) as Pick<Order, "id" | "order_number" | "total_amount" | "status" | "submitted_at">[];

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      <div className="flex items-center justify-between px-4 py-3.5 sticky top-0 z-10" style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
        <Link href="/catalog" aria-label="Back to catalog" style={{ color: palette.black }}>
          <ChevronLeft size={22} strokeWidth={1.5} />
        </Link>
        <div className="font-body uppercase" style={{ fontSize: 12, letterSpacing: "0.3em", color: palette.black }}>My Orders</div>
        <form action={logout}>
          <button type="submit" aria-label="Sign out" style={{ color: palette.mutedGreige }}>
            <LogOut size={18} strokeWidth={1.6} />
          </button>
        </form>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-5">
        {list.length === 0 ? (
          <div className="text-center py-20 font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em", lineHeight: 1.8 }}>
            No orders yet.
            <br />
            <Link href="/catalog" className="underline" style={{ color: palette.gold }}>Browse the catalog</Link> to place your first request.
          </div>
        ) : (
          <div className="flex flex-col">
            {list.map((o) => (
              <Link
                key={o.id}
                href={`/order/${o.id}`}
                className="flex items-center justify-between py-4"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}
              >
                <div>
                  <div className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{o.order_number}</div>
                  <div className="font-body mt-0.5" style={{ fontSize: 10, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
                    {fmtDate(o.submitted_at)} · {STATUS_LABEL[o.status] ?? o.status}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.black }}>{formatINR(o.total_amount)}</div>
                  <ChevronRight size={16} strokeWidth={1.6} color={palette.mutedGreige} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
