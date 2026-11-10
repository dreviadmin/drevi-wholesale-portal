import { requireAdminOrRedirect } from "@/lib/staff";
import { AutoRefresh } from "@/components/AutoRefresh";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { BuyersTable, type BuyerRowDTO } from "./BuyersTable";
import type { Buyer } from "@/lib/types";
import { e164 } from "@/lib/aisensy";

export const dynamic = "force-dynamic";

export default async function BuyersPage({
  searchParams,
}: {
  searchParams?: { status?: string; requests?: string };
}) {
  await requireAdminOrRedirect();
  const admin = createAdminClient();

  // Paged with fetchAll: a bare select stops at 1,000 rows without a word, so
  // buyers past that point vanished and order counts came up short. Buyers are
  // read oldest first (then id), so one signing up mid-read lands at the tail
  // rather than shifting a page boundary, then reversed to newest first.
  const [buyers, orders, identityReqs] = await Promise.all([
    fetchAll<Buyer>(admin, "buyers", "*", (q) => q.order("created_at", { ascending: true }).order("id", { ascending: true })),
    fetchAll<{ buyer_id: string; submitted_at: string }>(admin, "orders", "buyer_id, submitted_at", (q) => q.order("id")),
    fetchAll<{ buyer_id: string }>(admin, "buyer_change_requests", "buyer_id", (q) => q.eq("status", "pending").order("id")),
  ]);
  buyers.reverse();

  // The cockpit deep-links here with a filter in the query string. Until now
  // nothing read it, so "N identity changes to review" dropped staff on an
  // unfiltered list of every buyer with no clue which party was waiting.
  const pendingIdentity = new Set(identityReqs.map((r) => r.buyer_id));

  const stats = new Map<string, { count: number; last: string | null }>();
  for (const o of orders) {
    const s = stats.get(o.buyer_id) ?? { count: 0, last: null };
    s.count += 1;
    if (!s.last || o.submitted_at > s.last) s.last = o.submitted_at;
    stats.set(o.buyer_id, s);
  }

  const rows: BuyerRowDTO[] = buyers.map((b) => ({
    id: b.id,
    business_name: b.business_name,
    owner_name: b.owner_name,
    phone: b.phone,
    city: b.city,
    email: b.email,
    status: b.status,
    source: b.source,
    created_at: b.created_at,
    ordersCount: stats.get(b.id)?.count ?? 0,
    lastOrder: stats.get(b.id)?.last ?? null,
    // Drives the "n of m can be sent" count on the bulk bar. Only the boolean
    // crosses to the client — the encrypted password never leaves the server.
    // Same test the send applies: a landline or a broken number is not sendable.
    canSend: b.status === "active" && !!e164(b.phone) && !!b.encrypted_password,
    pendingIdentity: pendingIdentity.has(b.id),
  }));

  return (
    <>
      <AutoRefresh />
      <BuyersTable
        rows={rows}
        initialStatus={searchParams?.status ?? null}
        initialRequestsOnly={searchParams?.requests === "pending"}
      />
    </>
  );
}
