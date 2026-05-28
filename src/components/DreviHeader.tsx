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
          <button type="button" onClick={onCart} aria-label="Cart" className="relative">
            <ShoppingBag size={19} color={palette.black} strokeWidth={1.5} />
            {cartCount > 0 && (
              <span
                className="absolute -top-1.5 -right-1.5 flex items-center justify-center font-body"
                style={{ background: palette.gold, color: palette.black, fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: 8 }}
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
