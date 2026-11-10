import { describe, it, expect } from "vitest";
import { spacesForRole, spaceForPath, isNavItemActive, SPACES, type NavItem } from "./nav";

// Receipts history and each receipt sit at /admin/receipts[/<id>], while the
// Stock item is Log delivery at /admin/receipts/new, so those pages lit no tab
// at all. These pin the drill-ins to their space and item.

const admin = spacesForRole("admin");
const logDelivery = SPACES.find((s) => s.key === "stock")!.items.find((i) => i.href === "/admin/receipts/new")!;

describe("spaceForPath", () => {
  it("puts the receipts history, a receipt and Log delivery in Stock", () => {
    expect(spaceForPath("/admin/receipts", admin)).toBe("stock");
    expect(spaceForPath("/admin/receipts/3f2c9a1e-8b4d-4c7a-9e21-5d6f0a1b2c3d", admin)).toBe("stock");
    expect(spaceForPath("/admin/receipts/new", admin)).toBe("stock");
  });

  it("keeps drill-ins under their own item", () => {
    expect(spaceForPath("/admin/orders/x", admin)).toBe("office");
    expect(spaceForPath("/admin/exhibition/abc", admin)).toBe("sell");
    expect(spaceForPath("/admin/studio", admin)).toBe("studio");
  });

  it("does not match a path that only shares the letters of a prefix", () => {
    expect(spaceForPath("/admin/receiptsx", admin)).toBeNull();
    expect(spaceForPath("/admin/ordersheet", admin)).toBeNull();
  });

  it("matches nothing for pages that are not nav items", () => {
    expect(spaceForPath("/admin/credit-notes", admin)).toBeNull();
    expect(spaceForPath("/admin/home", admin)).toBe("home");
  });

  it("a Staff login has no Stock space, so receipts light nothing", () => {
    expect(spaceForPath("/admin/receipts/abc", spacesForRole("staff"))).toBeNull();
  });

  it("the longest matching prefix wins", () => {
    const spaces = [
      { key: "sell" as const, label: "nav.sell" as const, icon: "Store", roles: ["admin" as const], items: [{ label: "nav.catalog" as const, href: "/admin/a" }] },
      { key: "stock" as const, label: "nav.stock" as const, icon: "Boxes", roles: ["admin" as const], items: [{ label: "nav.vendors" as const, href: "/admin/x", match: ["/admin/a/b"] }] },
    ];
    expect(spaceForPath("/admin/a/b/c", spaces)).toBe("stock");
    expect(spaceForPath("/admin/a/c", spaces)).toBe("sell");
  });
});

describe("isNavItemActive", () => {
  it("lights Log delivery on its own page and on receipt pages", () => {
    expect(isNavItemActive("/admin/receipts/new", logDelivery)).toBe(true);
    expect(isNavItemActive("/admin/receipts", logDelivery)).toBe(true);
    expect(isNavItemActive("/admin/receipts/abc", logDelivery)).toBe(true);
    expect(isNavItemActive("/admin/stock-take", logDelivery)).toBe(false);
  });

  it("an item without match lights on its href and drill-ins only", () => {
    const orders: NavItem = { label: "nav.orders", href: "/admin/orders" };
    expect(isNavItemActive("/admin/orders", orders)).toBe(true);
    expect(isNavItemActive("/admin/orders/123", orders)).toBe(true);
    expect(isNavItemActive("/admin/ordersx", orders)).toBe(false);
    expect(isNavItemActive("/admin/buyers", orders)).toBe(false);
  });
});
