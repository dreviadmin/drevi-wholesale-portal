"use client";

import { Menu, Search, ShoppingBag } from "lucide-react";
import { palette } from "@/lib/palette";

// Buyer/mobile top bar + identity sub-bar, ported from the prototype.
export function DreviHeader({
  businessName,
  cartCount = 0,
  onMenu,
  onSearch,
  onCart,
}: {
  businessName?: string;
  cartCount?: number;
  onMenu?: () => void;
  onSearch?: () => void;
  onCart?: () => void;
}) {
  return (
    <div className="sticky top-0 z-10">
      <div
        className="flex items-center justify-between px-4 py-3.5"
        style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}
      >
        <button type="button" onClick={onMenu} aria-label="Menu">
          <Menu size={20} color={palette.black} strokeWidth={1.5} />
        </button>
        <div className="font-display" style={{ fontSize: 17, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>
          DREVI
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={onSearch} aria-label="Search">
            <Search size={19} color={palette.black} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={onCart}
            aria-label={`Cart (${cartCount})`}
            className="relative flex items-center justify-center"
            style={{
              width: 38,
              height: 38,
              borderRadius: 999,
              background: cartCount > 0 ? palette.gold : palette.ivoryDeep,
              border: `1px solid ${cartCount > 0 ? palette.goldDeep : "rgba(26,26,26,0.18)"}`,
              transition: "background 120ms",
            }}
          >
            <ShoppingBag size={20} color={palette.black} strokeWidth={1.8} />
            {cartCount > 0 && (
              <span
                className="absolute -top-1 -right-1 flex items-center justify-center font-body"
                style={{ background: palette.black, color: palette.ivory, fontSize: 9, fontWeight: 700, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9 }}
              >
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {businessName && (
        <div className="px-4 py-2.5" style={{ background: palette.ivoryDeep }}>
          <div className="font-body" style={{ color: palette.softBlack, fontSize: 10, letterSpacing: "0.15em" }}>
            WHOLESALE CATALOG · {businessName.toUpperCase()}
          </div>
        </div>
      )}
    </div>
  );
}
