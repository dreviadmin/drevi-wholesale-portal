import Link from "next/link";
import { requireAdminOrRedirect } from "@/lib/staff";
import { BackLink } from "@/components/BackLink";
import { loadCreditRegister } from "@/lib/credit-load";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { CreditRegister, type CreditRegisterRow } from "./CreditRegister";

export const dynamic = "force-dynamic";

// Credit-note register (Ansh, 11 Sep) — every credit ever granted, what it was
// raised against, and how much of it is still unspent. Reached from the
// Dashboard's Credit tile and from a party's Wallet card; deliberately not an
// eighth Office tab (see src/lib/nav.ts).
const PAGE_SIZE = 50;

export default async function CreditNotesPage({ searchParams }: { searchParams?: { q?: string; page?: string; from?: string } }) {
  await requireAdminOrRedirect();

  const q = (searchParams?.q ?? "").trim();
  const page = Math.max(1, Math.floor(Number(searchParams?.page)) || 1);
  // Always ranged: the register only grows, and an un-ranged select would
  // silently stop at PostgREST's 1000-row cap.
  const { rows, total } = await loadCreditRegister({ q: q || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  const registerRows: CreditRegisterRow[] = rows.map((r) => ({
    id: r.id,
    number: r.note_number,
    kind: r.kind,
    date: r.note_date,
    party: r.buyerName,
    buyerId: r.buyer_id,
    against: r.source_bill_number ?? r.orderNumber,
    orderId: r.order_id,
    reason: r.reason,
    total: Number(r.total) || 0,
    consumed: Number(r.consumed) || 0,
    remaining: Number(r.remaining) || 0,
    status: r.status,
  }));

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (n: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (n > 1) sp.set("page", String(n));
    if (searchParams?.from) sp.set("from", searchParams.from);
    const qs = sp.toString();
    return qs ? `/admin/credit-notes?${qs}` : "/admin/credit-notes";
  };
  const issued = registerRows.filter((r) => r.status === "issued");
  const unspent = issued.reduce((s, r) => s + r.remaining, 0);

  return (
    <div className="px-4 md:px-8 py-6 max-w-5xl">
      <BackLink fallback="/admin/dashboard" fallbackLabel="Dashboard" />

      <h1 className="font-display mt-4" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Credit notes</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack, maxWidth: 620 }}>
        Every credit granted to a party — returns raised against a bill, and manual adjustments. A note is the grant
        itself, so voiding one takes the credit back.
      </p>

      <div className="flex items-center justify-between gap-2 flex-wrap mt-4">
        <form method="get" action="/admin/credit-notes" className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px", background: "#fff" }}>
          {searchParams?.from && <input type="hidden" name="from" value={searchParams.from} />}
          <input name="q" defaultValue={q} placeholder="Search note no., party or order no." className="font-body bg-transparent outline-none" style={{ fontSize: 12.5, minWidth: 230, color: palette.black }} />
          <button type="submit" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep }}>Search</button>
        </form>
        <Link href="/admin/credit-notes/new" className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.16em", background: palette.gold, color: palette.black, padding: "10px 16px", fontWeight: 600 }}>
          + Issue credit note
        </Link>
      </div>

      <div className="font-body mt-3" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
        {total} note{total === 1 ? "" : "s"}{q ? ` matching “${q}”` : ""}
        {issued.length > 0 ? ` · ${formatINR(unspent)} unspent on this page` : ""}
        {pages > 1 ? ` · page ${page} of ${pages}` : ""}
      </div>

      <CreditRegister rows={registerRows} query={q} />

      {pages > 1 && (
        <div className="flex items-center gap-3 mt-4">
          {page > 1 && (
            <Link href={pageHref(page - 1)} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 12px" }}>← Newer</Link>
          )}
          {page < pages && (
            <Link href={pageHref(page + 1)} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 12px" }}>Older →</Link>
          )}
        </div>
      )}
    </div>
  );
}
