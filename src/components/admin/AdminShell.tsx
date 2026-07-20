"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, ShoppingBag, Store, Tent, ScrollText, Shield, LogOut, ScanLine, LayoutGrid, SlidersHorizontal, BarChart3, Tag, QrCode, Truck, PackageCheck } from "lucide-react";
import { logout } from "@/app/actions";
import { palette } from "@/lib/palette";
import type { StaffRole } from "@/lib/types";

const ICONS = { Users, ShoppingBag, Store, Tent, ScrollText, Shield, ScanLine, LayoutGrid, SlidersHorizontal, BarChart3, Tag, QrCode, Truck, PackageCheck } as const;

interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  superOnly?: boolean;
  adminOnly?: boolean; // admin / super_admin (spec §5)
}

// Menu order is deliberate: the three shop-floor tools first (price check,
// in-store billing, exhibitions), back-office after.
const NAV: NavItem[] = [
  { href: "/admin/retail-check", label: "Retail Price", icon: "Tag" },
  { href: "/admin/price-check", label: "Wholesale Price", icon: "ScanLine" },
  { href: "/admin/catalog", label: "Catalog", icon: "LayoutGrid" },
  { href: "/admin/in-store", label: "In-store", icon: "Store" },
  { href: "/admin/exhibition", label: "Exhibitions", icon: "Tent" },
  { href: "/admin/sku-generator", label: "SKU Generator", icon: "QrCode" },
  { href: "/admin/dashboard", label: "Dashboard", icon: "BarChart3", adminOnly: true },
  { href: "/admin/vendors", label: "Vendors", icon: "Truck", adminOnly: true },
  { href: "/admin/receipts", label: "Receipts", icon: "PackageCheck", adminOnly: true },
  { href: "/admin/buyers", label: "Buyers", icon: "Users", adminOnly: true },
  { href: "/admin/orders", label: "Orders", icon: "ShoppingBag", adminOnly: true },
  { href: "/admin/manage-catalog", label: "Manage Catalog", icon: "SlidersHorizontal", adminOnly: true },
  { href: "/admin/audit", label: "Audit Log", icon: "ScrollText", adminOnly: true },
  { href: "/admin/staff", label: "Staff", icon: "Shield", adminOnly: true },
];

const ROLE_LABEL: Record<StaffRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  staff: "Staff",
};

export function AdminShell({
  staff,
  children,
}: {
  staff: { name: string | null; email: string; role: StaffRole };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isAdmin = staff.role === "admin" || staff.role === "super_admin";
  const items = NAV.filter((n) => (!n.superOnly || staff.role === "super_admin") && (!n.adminOnly || isAdmin));

  function navLink(item: NavItem, compact = false) {
    const Icon = ICONS[item.icon];
    const active = pathname === item.href || pathname.startsWith(item.href + "/");
    return (
      <Link
        key={item.href}
        href={item.href}
        className="flex items-center gap-2.5 font-body uppercase whitespace-nowrap"
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          color: active ? palette.ivory : palette.champagne,
          background: active ? "rgba(196,163,90,0.18)" : "transparent",
          borderLeft: compact ? "none" : `2px solid ${active ? palette.gold : "transparent"}`,
          padding: compact ? "8px 12px" : "10px 16px",
        }}
      >
        <Icon size={15} strokeWidth={1.7} />
        {item.label}
      </Link>
    );
  }

  return (
    <div className="min-h-screen md:flex" style={{ background: palette.pageBg }}>
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex md:flex-col md:w-56 md:min-h-screen" style={{ background: palette.black }}>
        <div className="px-5 py-5">
          <div className="font-display" style={{ fontSize: 16, letterSpacing: "0.3em", color: palette.ivory, fontWeight: 600 }}>
            DREVI
          </div>
          <div className="font-body mt-0.5" style={{ fontSize: 9, letterSpacing: "0.25em", color: palette.gold }}>
            ADMIN
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 mt-2">{items.map((i) => navLink(i))}</nav>
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

      {/* Top bar + horizontal nav (mobile) */}
      <div className="md:hidden" style={{ background: palette.black }}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="font-display" style={{ fontSize: 14, letterSpacing: "0.3em", color: palette.ivory, fontWeight: 600 }}>
            DREVI · ADMIN
          </div>
          <form action={logout}>
            <button type="submit" className="font-body" style={{ color: palette.champagne }} aria-label="Sign out">
              <LogOut size={16} strokeWidth={1.7} />
            </button>
          </form>
        </div>
        <nav className="flex gap-1 px-2 pb-2 overflow-x-auto no-scrollbar">{items.map((i) => navLink(i, true))}</nav>
      </div>

      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
