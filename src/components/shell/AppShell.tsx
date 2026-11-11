"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House, Store, Boxes, Palette, Briefcase, ScanLine,
  Tag, QrCode, LayoutGrid, Tent, Truck, PackageCheck, Users,
  ShoppingBag, ScrollText, Shield, BarChart3, SlidersHorizontal, RefreshCw, Handshake,
  Building2, ListChecks,} from "lucide-react";
import { SignOutButton } from "@/components/SignOutButton";
import { palette } from "@/lib/palette";
import { t } from "@/lib/strings";
import { staffFirstName } from "@/lib/staff-name";
import { spacesForRole, spaceForPath, isNavItemActive, type Space } from "@/lib/nav";
import { ScanSheet } from "./ScanSheet";
import type { StaffRole } from "@/lib/types";

// App shell (build guide §6.3). Mobile: brand bar + body + bottom tab bar —
// Home, then the user's spaces in order, centre gold scan FAB. Desktop: left
// rail with space headers + expanded items, scan as a rail button. Both render
// from the ONE role-filtered config in src/lib/nav.ts.

const SPACE_ICONS = { House, Store, Boxes, Palette, Briefcase } as const;
const ITEM_ICONS: Record<string, typeof Tag> = {
  "/admin/retail-check": Tag,
  "/admin/retail-bill": Store,
  "/admin/price-check": ScanLine,
  "/admin/catalog": LayoutGrid,
  "/admin/exhibition": Tent,
  "/admin/in-store": Building2,
  "/admin/sku-generator": QrCode,
  "/admin/receipts": PackageCheck,
  "/admin/receipts/new": PackageCheck,
  "/admin/stock-take": Boxes,
  "/admin/vendors": Truck,
  "/admin/reorder": RefreshCw,
  // Studio's own icon, as on its bottom tab; without an entry it fell back to
  // Tag and looked like Retail Price.
  "/admin/studio": Palette,
  "/admin/dashboard": BarChart3,
  "/admin/orders": ShoppingBag,
  "/admin/buyers": Users,
  "/admin/agents": Handshake,
  "/admin/manage-catalog": SlidersHorizontal,
  "/admin/lovs": ListChecks,
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
  const [accountOpen, setAccountOpen] = useState(false);
  const spaces = spacesForRole(staff.role);
  const activeSpace = spaceForPath(pathname, spaces) ?? (pathname === "/admin" || pathname === "/admin/home" ? "home" : null);
  const tabSpaces = spaces.slice(0, MAX_TABS);
  const subTabs = spaces.find((s) => s.key === activeSpace)?.items ?? [];

  // Keep the active sub-tab in view when the strip overflows (Office has six).
  const activeSubTabRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeSubTabRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  // A fade on the strip's right edge while more sub-tabs sit off-screen; it
  // goes at the end of the strip. Runs after the scroll-into-view above.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) {
      setMoreRight(false);
      return;
    }
    // 1px of slack: scrollLeft is fractional on high-density screens.
    const update = () => setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // The web font can land after the first paint and change the widths.
    document.fonts?.ready.then(update).catch(() => {});
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [pathname, subTabs.length]);

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
                const active = isNavItemActive(pathname, i);
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
          {/* The spacing sits on a wrapper, not the button: the control owns a
              <form> of its own, so a margin on the button would be measured
              inside it rather than under the name above. */}
          <div className="mt-3">
            <SignOutButton style={{ gap: 6, fontSize: 9, letterSpacing: "0.18em", color: palette.champagne }} iconSize={12} />
          </div>
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
          {/* Who is signed in, as the desktop rail shows it. Log out sits in
              the sheet this opens, not bare beside the wordmark. The negative
              margin lets the 44px tap target fill the bar without growing it. */}
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={accountOpen}
            className="font-body truncate"
            style={{ fontSize: 11, color: palette.champagne, maxWidth: "62%", minHeight: 44, margin: "-12px -8px", padding: "0 8px" }}
          >
            {staffFirstName(staff)} · {ROLE_LABEL[staff.role]}
          </button>
        </div>
        {subTabs.length > 1 && (
          <div className="relative">
            <div
              ref={stripRef}
              className="flex overflow-x-auto"
              style={{ borderTop: "1px solid rgba(196,163,90,0.18)", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
            >
              {subTabs.map((i) => {
                const active = isNavItemActive(pathname, i);
                return (
                  <Link
                    key={i.href}
                    href={i.href}
                    ref={active ? activeSubTabRef : undefined}
                    className="flex-none font-body uppercase whitespace-nowrap"
                    style={{
                      fontSize: 11.5, letterSpacing: "0.14em",
                      color: active ? palette.ivory : palette.champagne,
                      borderBottom: `2px solid ${active ? palette.gold : "transparent"}`,
                      padding: "13px 14px 11px",
                    }}
                  >
                    {t(i.label)}
                  </Link>
                );
              })}
            </div>
            {moreRight && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute right-0 bottom-0"
                style={{ top: 1, width: 24, background: `linear-gradient(to left, ${palette.black}, rgba(26,26,26,0))` }}
              />
            )}
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
              style={{ fontSize: 11, letterSpacing: "0.06em", color: active ? palette.gold : palette.champagne }}
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
      {accountOpen && <AccountSheet staff={staff} onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

// Phone account sheet (same pattern as CancelBillButton): who is signed in,
// Log out, and a way back without logging out.
function AccountSheet({
  staff,
  onClose,
}: {
  staff: { name: string | null; email: string; role: StaffRole };
  onClose: () => void;
}) {
  const name = staff.name?.trim() || null;
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-sheet-title"
        className="w-full sm:max-w-md max-h-modal overflow-y-auto"
        style={{ background: palette.ivory, padding: "20px 18px calc(20px + env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="account-sheet-title" className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.2em", color: palette.mutedGreige }}>
          Signed in as
        </div>
        <div className="font-display mt-2" style={{ fontSize: 18, fontWeight: 600, color: palette.black, overflowWrap: "anywhere" }}>
          {name ?? staff.email}
        </div>
        {name && (
          <div className="font-body mt-0.5" style={{ fontSize: 13, color: palette.softBlack, overflowWrap: "anywhere" }}>{staff.email}</div>
        )}
        <div className="font-body uppercase mt-1.5" style={{ fontSize: 11, letterSpacing: "0.15em", color: palette.goldDeep }}>
          {ROLE_LABEL[staff.role]}
        </div>
        <div className="flex gap-2 mt-5">
          <div className="flex-1">
            <SignOutButton
              className="w-full justify-center"
              style={{ gap: 6, fontSize: 11, letterSpacing: "0.16em", color: palette.ivory, background: palette.black, minHeight: 44, padding: "12px 0" }}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 font-body uppercase"
            style={{ fontSize: 11, letterSpacing: "0.14em", color: palette.softBlack, border: "1px solid rgba(26,26,26,0.2)", minHeight: 44, padding: "12px 0" }}
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
