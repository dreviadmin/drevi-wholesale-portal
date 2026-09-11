import { requireAdminOrRedirect } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { BackLink } from "@/components/BackLink";
import { palette } from "@/lib/palette";
import { ManualCreditForm, type PickerBuyer } from "./ManualCreditForm";

export const dynamic = "force-dynamic";

// Manual credit note (Ansh, 11 Sep) — a goodwill or adjustment credit with no
// goods behind it. Returns are raised from the order they came back from; this
// screen exists for everything else.
export default async function NewCreditNotePage({ searchParams }: { searchParams?: { buyer?: string } }) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  // fetchAll, not a bare select: the picker must not quietly stop listing
  // parties once the book passes PostgREST's 1000-row cap.
  const buyers = await fetchAll<{ id: string; business_name: string | null; owner_name: string | null; phone: string | null; city: string | null; status: string }>(
    admin,
    "buyers",
    "id, business_name, owner_name, phone, city, status",
  );
  const picker: PickerBuyer[] = buyers
    .map((b) => ({
      id: b.id,
      name: b.business_name ?? b.owner_name ?? "(unnamed party)",
      sub: [b.owner_name, b.city, b.phone].filter(Boolean).join(" · "),
      status: b.status,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rawBuyer = searchParams?.buyer;
  const preselect = rawBuyer && /^[0-9a-f-]{36}$/i.test(rawBuyer) ? rawBuyer : null;
  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <BackLink fallback="/admin/credit-notes" fallbackLabel="Credit notes" />

      <h1 className="font-display mt-4" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Issue a credit note</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack }}>
        A manual credit — goodwill, a settlement, an adjustment. No goods come back and no stock moves. The amount
        lands in the party&rsquo;s wallet immediately and can be applied to any of their orders.
        For goods that were actually returned, raise the note from the order they were billed on.
      </p>

      <ManualCreditForm buyers={picker} preselectBuyerId={preselect} todayIst={todayIst} />
    </div>
  );
}
