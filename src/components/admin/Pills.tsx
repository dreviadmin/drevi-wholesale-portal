import { palette } from "@/lib/palette";
import type { BuyerStatus, BuyerSource } from "@/lib/types";

// Buyer status pill — same visual family as the stock pills (spec §7.3).
export function StatusPill({ status }: { status: BuyerStatus }) {
  const base = "inline-flex items-center gap-1.5 font-body uppercase text-[9px] px-2 py-0.5";
  const tracking = { letterSpacing: "0.12em" } as const;
  if (status === "active")
    return (
      <span className={base} style={{ color: palette.softBlack, ...tracking }}>
        <span style={{ width: 6, height: 6, borderRadius: 9, background: palette.gold, display: "inline-block" }} />
        Active
      </span>
    );
  if (status === "pending")
    return <span className={base} style={{ color: palette.goldDeep, background: palette.amberSoft, border: `1px solid ${palette.champagne}`, ...tracking }}>Pending</span>;
  if (status === "suspended")
    return <span className={base} style={{ color: palette.muted, background: palette.soldBg, ...tracking }}>Suspended</span>;
  return <span className={base} style={{ color: palette.crimsonText, background: palette.crimsonSoft, border: `1px solid ${palette.crimsonBorder}`, ...tracking }}>Rejected</span>;
}

const SOURCE_LABEL: Record<BuyerSource, string> = {
  inquiry_form: "Inquiry",
  exhibition: "Exhibition",
  manual_admin: "Manual",
};

export function SourcePill({ source }: { source: BuyerSource }) {
  return (
    <span
      className="inline-flex items-center font-body uppercase text-[9px] px-2 py-0.5"
      style={{ color: palette.mutedGreige, border: "1px solid rgba(26,26,26,0.18)", letterSpacing: "0.12em" }}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}
