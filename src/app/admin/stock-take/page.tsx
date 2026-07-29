import Link from "next/link";
import { requireAdminOrRedirect } from "@/lib/staff";
import { reconcile } from "@/lib/stock-ledger";
import { palette } from "@/lib/palette";
import { StockTake } from "./StockTake";
import { DriftReport } from "../stock-check/DriftReport";

export const dynamic = "force-dynamic";

// UX sprint (29 Jul) — ONE stock screen. "Count" is the walk-the-rack flow;
// "Check" is the ledger-vs-cache drift report that used to be its own nav
// item. Device/floor scope stays parked (ANSH-20) → admin-role gated.
export default async function StockCountPage({ searchParams }: { searchParams?: { tab?: string } }) {
  await requireAdminOrRedirect();
  const tab = searchParams?.tab === "check" ? "check" : "count";
  const drift = tab === "check" ? await reconcile() : null;

  return (
    <div>
      <div className="px-4 md:px-8 pt-5 flex gap-1.5">
        {([["count", "Count"], ["check", "Check"]] as const).map(([key, label]) => (
          <Link
            key={key}
            href={key === "count" ? "/admin/stock-take" : "/admin/stock-take?tab=check"}
            className="font-body uppercase"
            style={{
              fontSize: 9.5, letterSpacing: "0.16em", padding: "7px 14px",
              background: tab === key ? palette.black : "transparent",
              color: tab === key ? palette.ivory : palette.softBlack,
              border: tab === key ? "none" : "1px solid rgba(26,26,26,0.18)",
            }}
          >
            {label}
          </Link>
        ))}
      </div>
      {tab === "count" ? <StockTake /> : <DriftReport checked={drift!.checked} rows={drift!.drift} />}
    </div>
  );
}
