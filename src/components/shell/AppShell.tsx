"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House, Store, Boxes, Palette, Briefcase, ScanLine, LogOut,
  Tag, QrCode, LayoutGrid, Tent, Truck, PackageCheck, Users,
  ShoppingBag, ScrollText, Shield, BarChart3, SlidersHorizontal, RefreshCw,
} from "lucide-react";
import { logout } from "@/app/actions";
import { palette } from "@/lib/palette";
import { t } from "@/lib/strings";
import { spacesForRole, spaceForPath, type Space } from "@/lib/nav";
import { ScanSheet } from "./ScanSheet";
import type { StaffRole } from "@/lib/types";

// App shell (build guide §6.3). Mobile: brand bar + body + bottom tab bar —
// Home, then the user's spaces in order, centre gold scan FAB. Desktop: left
// rail with space headers + expanded items, scan as a rail button. Both render
// from the ONE role-filtered config in src/lib/nav.ts.

const SPACE_ICONS = { House, Store, Boxes, Palette, Briefcase } as const;
const ITEM_ICONS: Record<string, typeof Tag> = {
  "/admin/retail-check": Tag,
  "/admin/price-check": ScanLine,
  "/admin/catalog": LayoutGrid,
  "/admin/exhibition": Tent,
  "/admin/in-store": Store,
  "/admin/sku-generator": QrCode,
  "/admin/receipts": PackageCheck,
  "/admin/receipts/new": PackageCheck,
  "/admin/stock-take": Boxes,
  "/admin/vendors": Truck,
  "/admin/reorder": RefreshCw,
  "/admin/dashboard": BarChart3,
  "/admin/orders": ShoppingBag,
  "/admin/buyers": Users,
  "/admin/manage-catalog": SlidersHorizontal,
  "/admin/lovs": SlidersHorizontal,
  "/admin/audit": ScrollText,
  "/admin/staff": Shield,
  "/admin/home": House,
};

const ROLE_LABEL: Record<StaffRole, string> = { super_admin: "Super Admin", admin: "Admin", staff: "Staff" };

// All five spaces fit beside the FAB at 375px (5 × ~61px + 68px FAB). Slicing
// at 4 used to drop Office from phones entirely — the whole back office was
// desktop-only the moment everyone became admin (Ansh, 18 Aug).
const MAX_TABS = 5;

export function AppShell({
  staff,
  children,
}: {
  staff: { name: string | null; email: string; role: StaffRole };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [scanOpen, setScanOpen] = useState(false);
  const spaces = spacesForRole(staff.role);
  const activeSpace = spaceForPath(pathname, spaces) ?? (pathname === "/admin" || pathname === "/admin/home" ? "home" : null);
  const tabSpaces = spaces.slice(0, MAX_TABS);
  const subTabs = spaces.find((s) => s.key === activeSpace)?.items ?? [];

  // Keep the active sub-tab in view when the strip overflows (Office has six).
  const activeSubTabRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeSubTabRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  function spaceHome(s: Space): string {
    return s.items[0]?.href ?? "/admin/home";
  }

  return (
    <div className="min-h-screen md:flex" style={{ background: palette.pageBg }}>
      {/* Desktop left rail */}
      <aside className="hidden md:flex md:flex-col md:w-60 md:min-h-screen md:sticky md:top-0 md:max-h-screen md:overflow-y-auto" style={{ background: palette.black }}>
        <div className="px-5 py-5">
          <div className="font-display" style={{ fontSize: 16, letterSpacing: "0.3em", color: palette.ivory, fontWeight: 600 }}>DREVI</div>
          <div className="font-body mt-0.5" style={{ fontSize: 9, letterSpacing: "0.25em", color: palette.gold }}>
            {ROLE_LABEL[staff.role].toUpperCase()}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setScanOpen(true)}
          className="mx-4 mb-2 flex items-center justify-center gap-2 font-body uppercase"
          style={{ fontSize: 10.5, letterSpacing: "0.2em", padding: "11px 0", background: palette.gold, color: palette.black, fontWeight: 600 }}
        >
          <ScanLine size={14} strokeWidth={2} /> {t("nav.scan")}
        </button>

        <nav className="flex flex-col mt-1">
          {spaces.map((s) => (
            <div key={s.key} className="mb-1.5">
              <div className="px-5 pt-3 pb-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.24em", color: s.key === activeSpace ? palette.gold : "rgba(214,197,161,0.55)" }}>
                {t(s.label)}
              </div>
              {s.items.map((i) => {
                const Icon = ITEM_ICONS[i.href] ?? Tag;
                const active = pathname === i.href || pathname.startsWith(i.href + "/");
                return (
                  <Link
                    key={i.href}
                    href={i.href}
                    className="flex items-center gap-2.5 font-body uppercase whitespace-nowrap"
                    style={{
                      fontSize: 11, letterSpacing: "0.12em",
                      color: active ? palette.ivory : palette.champagne,
                      background: active ? "rgba(196,163,90,0.18)" : "transparent",
                      borderLeft: `2px solid ${active ? palette.gold : "transparent"}`,
                      padding: "9px 16px",
                    }}
                  >
                    <Icon size={15} strokeWidth={1.7} />
                    {t(i.label)}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto px-5 py-5">
          <div className="font-body" style={{ fontSize: 11, color: palette.ivory }}>{staff.name ?? staff.email}</div>
          <div className="font-body mt-0.5" style={{ fontSize: 9, letterSpacing: "0.15em", color: palette.gold, textTransform: "uppercase" }}>
            {ROLE_LABEL[staff.role]}
          </div>
          <form action={logout} className="mt-3">
            <button type="submit" className="flex items-center gap-1.5 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.champagne }}>
              <LogOut size={12} strokeWidth={1.7} /> Sign Out
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile brand bar + the active space's sub-tabs (one sticky block, so
          the strip never detaches from the bar). Phones used to land on a
          space's first page with its sibling pages invisible — desktop's rail
          showed them all. Same nav config now renders on both (Ansh, 18 Aug). */}
      <div className="md:hidden sticky top-0 z-40" style={{ background: palette.black }}>
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/admin/home" className="font-display" style={{ fontSize: 14, letterSpacing: "0.3em", color: palette.ivory, fontWeight: 600 }}>
            DREVI
          </Link>
          <form action={logout}>
            <button type="submit" className="font-body" style={{ color: palette.champagne }} aria-label="Sign out">
              <LogOut size={16} strokeWidth={1.7} />
            </button>
          </form>
        </div>
        {subTabs.length > 1 && (
          <div
            className="flex overflow-x-auto"
            style={{ borderTop: "1px solid rgba(196,163,90,0.18)", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
          >
            {subTabs.map((i) => {
              const active = pathname === i.href || pathname.startsWith(i.href + "/");
              return (
                <Link
                  key={i.href}
                  href={i.href}
                  ref={active ? activeSubTabRef : undefined}
                  className="flex-none font-body uppercase whitespace-nowrap"
                  style={{
                    fontSize: 9.5, letterSpacing: "0.14em",
                    color: active ? palette.ivory : palette.champagne,
                    borderBottom: `2px solid ${active ? palette.gold : "transparent"}`,
                    padding: "10px 14px 8px",
                  }}
                >
                  {t(i.label)}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Body — bottom padding clears the mobile tab bar */}
      <main className="flex-1 min-w-0 pb-20 md:pb-0">{children}</main>

      {/* Mobile bottom tabs + centre scan FAB */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 flex items-stretch"
        style={{ background: palette.black, borderTop: "1px solid rgba(196,163,90,0.25)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabSpaces.map((s, idx) => {
          const Icon = SPACE_ICONS[s.icon as keyof typeof SPACE_ICONS] ?? House;
          const active = s.key === activeSpace;
          const tab = (
            <Link
              key={s.key}
              href={spaceHome(s)}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 font-body uppercase"
              style={{ fontSize: 8, letterSpacing: "0.14em", color: active ? palette.gold : palette.champagne }}
            >
              <Icon size={18} strokeWidth={active ? 2 : 1.6} />
              {t(s.label)}
            </Link>
          );
          // Centre FAB sits after the first half of the tabs.
          if (idx === Math.ceil(tabSpaces.length / 2) - 1) {
            return (
              <span key={s.key} className="contents">
                {tab}
                <div className="flex items-center justify-center px-1" style={{ width: 68 }}>
                  <button
                    type="button"
                    onClick={() => setScanOpen(true)}
                    aria-label={t("nav.scan")}
                    className="flex items-center justify-center rounded-full"
                    style={{ width: 52, height: 52, marginTop: -18, background: palette.gold, boxShadow: "0 4px 14px rgba(196,163,90,0.5)" }}
                  >
                    <ScanLine size={22} strokeWidth={2.2} color={palette.black} />
                  </button>
                </div>
              </span>
            );
          }
          return tab;
        })}
      </nav>

      {scanOpen && <ScanSheet onClose={() => setScanOpen(false)} />}
    </div>
  );
}
