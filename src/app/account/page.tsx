import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SignOutButton } from "@/components/SignOutButton";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadBuyerWalletPublic } from "@/lib/credit-load";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";

export const dynamic = "force-dynamic";

// The buyer's account hub (13 Sep). Orders, credit and details each used to be
// reached from a different place — the header menu, whichever page happened to
// render the wallet, nowhere at all. One entry point, and each surface owns
// exactly one thing.

export default async function AccountPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  // Named columns, never select("*") — this row also holds encrypted_password,
  // staff notes and cost-side fields.
  const { data: rows } = await createAdminClient()
    .from("buyers")
    .select("id, business_name, owner_name, city, status")
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = rows?.[0];
  if (!buyer || buyer.status !== "active") redirect("/login");

  const wallet = await loadBuyerWalletPublic(buyer.id as string);
  const hasCredit = wallet.balance > 0 || wallet.notes.length > 0;

  const links: { href: string; label: string; sub: string; value?: string }[] = [
    { href: "/account/orders", label: "My orders", sub: "Everything you have ordered, with invoices" },
    {
      href: "/account/credit",
      label: "Credit",
      sub: hasCredit ? "Credit notes and where they went" : "No credit on your account right now",
      value: wallet.balance > 0 ? formatINR(wallet.balance) : undefined,
    },
    { href: "/account/details", label: "My details", sub: "Phone, address, transport and broker" },
  ];

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      {/* Equal flanks rather than justify-between: the sign-out control carries
          words now, so a chevron on one side and a labelled button on the other
          would drag the title ~26px off centre. Widest case is this title at
          320px — 120px of label against 84px of flank, and the control needs
          74px — so nothing wraps. */}
      <div className="flex items-center px-4 py-3.5 sticky top-0 z-10" style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
        <div className="flex-1 flex">
          <Link href="/home" aria-label="Back to home" style={{ color: palette.black }}>
            <ChevronLeft size={22} strokeWidth={1.5} />
          </Link>
        </div>
        <div className="font-body uppercase whitespace-nowrap" style={{ fontSize: 12, letterSpacing: "0.3em", color: palette.black }}>My Account</div>
        <div className="flex-1 flex justify-end">
          <SignOutButton />
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black, lineHeight: 1.3 }}>
          {buyer.business_name ?? "Your shop"}
        </div>
        <div className="font-body mt-1" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
          {[buyer.owner_name, buyer.city].filter(Boolean).join(" · ") || "Wholesale account"}
        </div>

        <div className="flex flex-col mt-6">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center justify-between gap-3 py-4"
              style={{ borderTop: "1px solid rgba(26,26,26,0.08)" }}
            >
              <div className="min-w-0">
                <div className="font-body" style={{ fontSize: 13.5, color: palette.black }}>{l.label}</div>
                <div className="font-body mt-0.5" style={{ fontSize: 10.5, color: palette.mutedGreige, letterSpacing: "0.04em" }}>{l.sub}</div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                {l.value && (
                  <span className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.goldDeep }}>{l.value}</span>
                )}
                <ChevronRight size={16} strokeWidth={1.6} color={palette.mutedGreige} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
