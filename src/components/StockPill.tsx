import { getStockState, type StockInput } from "@/lib/stock";
import { palette } from "@/lib/palette";

// The central design-language piece. Four states, distinct treatments — ported
// faithfully from the catalog prototype. `asOf` adds the offline time caveat
// (Phase 4) to the live-stock states only.
export function StockPill({
  product,
  compact = false,
  asOf,
}: {
  product: StockInput;
  compact?: boolean;
  asOf?: string;
}) {
  const state = getStockState(product);
  const base = "inline-flex items-center gap-1.5 font-body uppercase";
  const size = compact ? "text-[9px] px-2 py-0.5" : "text-[10px] px-2.5 py-1";
  const cls = `${base} ${size}`;
  const tracking = { letterSpacing: "0.12em" };
  const caveat = asOf ? ` (as of ${asOf})` : "";

  if (state === "ready") {
    return (
      <span className={cls} style={{ color: palette.softBlack, ...tracking }}>
        <span style={{ width: 6, height: 6, borderRadius: 9, background: palette.gold, display: "inline-block" }} />
        In Stock{caveat}
      </span>
    );
  }
  if (state === "limited") {
    return (
      <span
        className={cls}
        style={{ color: palette.crimsonText, background: palette.crimsonSoft, border: `1px solid ${palette.crimsonBorder}`, ...tracking }}
      >
        Limited · {product.current_qty} left{caveat}
      </span>
    );
  }
  if (state === "made_to_order") {
    return (
      <span className={cls} style={{ color: palette.goldDeep, border: `1px solid ${palette.gold}`, ...tracking }}>
        Made to Order · {product.restock_days}d
      </span>
    );
  }
  return (
    <span className={cls} style={{ color: palette.muted, background: palette.soldBg, ...tracking }}>
      Sold Out
    </span>
  );
}
