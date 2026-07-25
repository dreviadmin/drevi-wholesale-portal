// Navigation config (build guide §6.1). ONE typed config drives both the
// mobile bottom tabs and the desktop left rail. Roles gate at space level and
// optionally per item. Spaces with zero visible items don't render — Studio
// stays defined here but empty until Stage 3 lands its board route.

import type { StaffRole } from "@/lib/types";
import type { StringKey } from "@/lib/strings";

export interface NavItem {
  label: StringKey;
  href: string;
  roles?: StaffRole[]; // default: inherit the space's roles
}

export interface Space {
  key: "home" | "sell" | "stock" | "studio" | "office";
  label: StringKey;
  icon: string; // lucide icon name, resolved in the shell
  roles: StaffRole[];
  items: NavItem[];
}

const STAFF_PLUS: StaffRole[] = ["staff", "admin", "super_admin"];
const ADMIN_PLUS: StaffRole[] = ["admin", "super_admin"];
const SUPER_ONLY: StaffRole[] = ["super_admin"];

export const SPACES: Space[] = [
  { key: "home", label: "nav.home", icon: "House", roles: STAFF_PLUS, items: [{ label: "nav.home", href: "/admin/home" }] },
  {
    key: "sell",
    label: "nav.sell",
    icon: "Store",
    roles: STAFF_PLUS,
    items: [
      { label: "nav.retail_check", href: "/admin/retail-check" },
      { label: "nav.price_check", href: "/admin/price-check" },
      { label: "nav.catalog", href: "/admin/catalog" },
      { label: "nav.exhibition", href: "/admin/exhibition" },
      { label: "nav.in_store", href: "/admin/in-store" },
    ],
  },
  {
    // Space itself is admin+ (a `staff` login sees only Home+Sell, guide §6
    // done-when); staff still reach the SKU generator via the Home quick
    // action — the route's own access stays staff+ per the Phase 1 matrix.
    key: "stock",
    label: "nav.stock",
    icon: "Boxes",
    roles: ADMIN_PLUS,
    items: [
      { label: "nav.sku_generator", href: "/admin/sku-generator" },
      { label: "nav.receipts", href: "/admin/receipts" },
      { label: "nav.vendors", href: "/admin/vendors" },
      { label: "nav.reorder", href: "/admin/reorder" },
    ],
  },
  {
    // Grishma's Studio access is parked (ANSH-09) — admin+ until confirmed.
    key: "studio",
    label: "nav.studio",
    icon: "Palette",
    roles: ADMIN_PLUS,
    items: [{ label: "nav.studio", href: "/admin/studio" }],
  },
  {
    key: "office",
    label: "nav.office",
    icon: "Briefcase",
    roles: ADMIN_PLUS,
    items: [
      { label: "nav.dashboard", href: "/admin/dashboard" },
      { label: "nav.orders", href: "/admin/orders" },
      { label: "nav.buyers", href: "/admin/buyers" },
      { label: "nav.manage_catalog", href: "/admin/manage-catalog" },
      { label: "nav.audit", href: "/admin/audit" },
      { label: "nav.staff", href: "/admin/staff", roles: SUPER_ONLY },
    ],
  },
];

export function spacesForRole(role: StaffRole): Space[] {
  return SPACES.map((s) => ({
    ...s,
    items: s.items.filter((i) => (i.roles ?? s.roles).includes(role)),
  })).filter((s) => s.roles.includes(role) && s.items.length > 0);
}

// Which space a pathname belongs to (longest item-href prefix wins) — keeps
// the parent tab/rail section lit on drill-ins like /admin/orders/[id].
export function spaceForPath(pathname: string, spaces: Space[]): Space["key"] | null {
  let best: { key: Space["key"]; len: number } | null = null;
  for (const s of spaces) {
    for (const i of s.items) {
      if ((pathname === i.href || pathname.startsWith(i.href + "/") || pathname.startsWith(i.href + "?")) && (!best || i.href.length > best.len)) {
        best = { key: s.key, len: i.href.length };
      }
    }
  }
  return best?.key ?? null;
}
