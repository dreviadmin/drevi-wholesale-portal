import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { SignOutButton } from "@/components/SignOutButton";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadBuyerWalletPublic } from "@/lib/credit-load";
import { BuyerWalletCard } from "@/components/BuyerWalletCard";
import { palette } from "@/lib/palette";

export const dynamic = "force-dynamic";

// The wallet's own page (13 Sep). The card hides itself when there has never
// been any credit — correct on the storefront home, where it is one block among
// many, but a page that renders nothing needs to say so itself.

export default async function AccountCreditPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  const { data: rows } = await createAdminClient()
    .from("buyers")
    .select("id, status")
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = rows?.[0];
  if (!buyer || buyer.status !== "active") redirect("/login");

  // credit_notes and credit_ledger are RLS-on with no policies, so this reads
  // with the admin client — against the buyer id resolved above, never one that
  // arrived from the client.
  const wallet = await loadBuyerWalletPublic(buyer.id as string);
  const hasCredit = wallet.balance > 0 || wallet.notes.length > 0;

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      {/* The right slot was a 22px spacer, so this page offered no way out at
          all — it has no drawer either. Equal flanks keep the title centred. */}
      <div className="flex items-center px-4 py-3.5 sticky top-0 z-10" style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
        <div className="flex-1 flex">
          <Link href="/account" aria-label="Back to my account" style={{ color: palette.black }}>
            <ChevronLeft size={22} strokeWidth={1.5} />
          </Link>
        </div>
        <div className="font-body uppercase whitespace-nowrap" style={{ fontSize: 12, letterSpacing: "0.3em", color: palette.black }}>Credit</div>
        <div className="flex-1 flex justify-end">
          <SignOutButton />
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-5">
        {hasCredit ? (
          <BuyerWalletCard wallet={wallet} />
        ) : (
          <div className="text-center py-20 font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em", lineHeight: 1.8 }}>
            No credit on your account right now.
            <br />
            Returns and adjustments show up here.
          </div>
        )}
      </div>
    </div>
  );
}
