"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X, Search, ShoppingBag, LogOut, ClipboardList, Store } from "lucide-react";
import { logout } from "@/app/actions";
import { palette } from "@/lib/palette";

// Buyer/mobile top bar + identity sub-bar, ported from the prototype. The
// hamburger opens a small menu (navigation + sign out).
export function DreviHeader({
  businessName,
  cartCount = 0,
  onSearch,
  onCart,
}: {
  businessName?: string;
  cartCount?: number;
  onSearch?: () => void;
  onCart?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="sticky top-0 z-20">
      <div
        className="flex items-center justify-between px-4 py-3.5"
        style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}
      >
        <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
          {menuOpen ? <X size={20} color={palette.black} strokeWidth={1.5} /> : <Menu size={20} color={palette.black} strokeWidth={1.5} />}
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

      {/* Menu drawer */}
      {menuOpen && (
        <div
          className="absolute left-0 right-0 flex flex-col"
          style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.12)", boxShadow: "0 16px 40px rgba(26,26,26,0.12)" }}
        >
          <Link href="/catalog" onClick={() => setMenuOpen(false)} className="flex items-center gap-2.5 font-body uppercase px-5 py-3.5" style={{ fontSize: 11, letterSpacing: "0.16em", color: palette.black, borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
            <Store size={15} strokeWidth={1.7} /> Catalog
          </Link>
          <Link href="/cart" onClick={() => setMenuOpen(false)} className="flex items-center gap-2.5 font-body uppercase px-5 py-3.5" style={{ fontSize: 11, letterSpacing: "0.16em", color: palette.black, borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
            <ShoppingBag size={15} strokeWidth={1.7} /> Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </Link>
          <Link href="/account/orders" onClick={() => setMenuOpen(false)} className="flex items-center gap-2.5 font-body uppercase px-5 py-3.5" style={{ fontSize: 11, letterSpacing: "0.16em", color: palette.black, borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
            <ClipboardList size={15} strokeWidth={1.7} /> My Orders
          </Link>
          <form action={logout}>
            <button type="submit" className="w-full flex items-center gap-2.5 font-body uppercase px-5 py-3.5" style={{ fontSize: 11, letterSpacing: "0.16em", color: palette.crimsonText }}>
              <LogOut size={15} strokeWidth={1.7} /> Sign Out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
