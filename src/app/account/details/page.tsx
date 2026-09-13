import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { SignOutButton } from "@/components/SignOutButton";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { palette } from "@/lib/palette";
import { DetailsForm, type IdentityRequestDTO } from "./DetailsForm";

export const dynamic = "force-dynamic";

// The buyer's own details. Named columns only: this row also carries
// encrypted_password, staff notes and approval provenance, and everything the
// page selects reaches the browser in the RSC payload.

export default async function AccountDetailsPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("buyers")
    .select("id, business_name, gstin, phone, address, city, transport_details, broker_details, status")
    .eq("email", user.email)
    .not("encrypted_password", "is", null)
    .limit(1);
  const buyer = rows?.[0];
  if (!buyer || buyer.status !== "active") redirect("/login");

  // buyer_change_requests is RLS-on with no policies (service-role only), so
  // this is scoped by hand to the buyer resolved from the session above.
  const { data: reqRows } = await admin
    .from("buyer_change_requests")
    .select("id, field, requested_value, status, requested_at, decided_at, decision_note")
    .eq("buyer_id", buyer.id)
    .order("requested_at", { ascending: false })
    .limit(10);

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
        <div className="font-body uppercase whitespace-nowrap" style={{ fontSize: 12, letterSpacing: "0.3em", color: palette.black }}>My Details</div>
        <div className="flex-1 flex justify-end">
          <SignOutButton />
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 pb-24">
        <DetailsForm
          // Per buyer, so a shared shop device cannot restore one account's
          // draft into another's form after a re-login.
          draftKey={`drevi:draft:account-details:${buyer.id}`}
          seed={{
            phone: buyer.phone ?? "",
            address: buyer.address ?? "",
            city: buyer.city ?? "",
            transport_details: buyer.transport_details ?? "",
            broker_details: buyer.broker_details ?? "",
          }}
          identity={{ business_name: buyer.business_name ?? "", gstin: buyer.gstin ?? "" }}
          requests={(reqRows ?? []) as IdentityRequestDTO[]}
        />
      </div>
    </div>
  );
}
