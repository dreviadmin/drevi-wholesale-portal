// Strings layer (build guide §6.2). Every NEW user-facing label goes through
// t() — English now, Hindi later without a rewrite. Legacy screens migrate
// only when a file is already being touched.

const STRINGS = {
  en: {
    // nav — spaces
    "nav.home": "Home",
    "nav.sell": "Sell",
    "nav.stock": "Stock",
    "nav.studio": "Studio",
    "nav.office": "Office",
    "nav.scan": "Scan",
    // nav — items
    "nav.retail_check": "Retail Price",
    "nav.retail_bill": "Retail Billing",
    "nav.price_check": "Wholesale Price",
    "nav.catalog": "Catalog",
    "nav.exhibition": "Exhibitions",
    "nav.in_store": "In-store",
    "nav.sku_generator": "SKU Generator",
    "nav.receipts": "Receipts",
    "nav.log_delivery": "Log delivery",
    "nav.stock_take": "Stock count",
    "nav.stock_check": "Stock check",
    "nav.specs": "Specs",
    "nav.vendors": "Vendors",
    "nav.reorder": "Reorder",
    "nav.dashboard": "Dashboard",
    "nav.orders": "Orders",
    "nav.buyers": "Buyers",
    "nav.manage_catalog": "Manage Catalog",
    "nav.lovs": "Lists",
    "nav.audit": "Audit Log",
    "nav.staff": "Staff",
    // home cockpit
    "home.greeting.morning": "Good morning",
    "home.greeting.afternoon": "Good afternoon",
    "home.greeting.evening": "Good evening",
    "home.today": "Today",
    "home.sales": "Sales",
    "home.orders": "Orders",
    "home.pieces": "pcs",
    "home.advance_in": "Advance in",
    "home.balance_due": "Balance due",
    "home.needs_you": "Needs you",
    "home.all_clear": "All clear",
    "home.quick_actions": "Quick actions",
    "home.spaces": "Spaces",
    "home.action.scan": "Scan",
    "home.action.new_bill": "New bill",
    "home.action.new_sku": "New SKU",
    "home.action.log_receipt": "Log receipt",
    "home.action.price_check": "Price check",
    "home.synced": "Synced",
    // scan sheet
    "scan.title": "Scan a tag",
    "scan.unknown": "Not in the system",
    "scan.create_sku": "Create SKU",
    "scan.check_retail": "Check retail price",
    "scan.add_to_bill": "Add to current bill",
    "scan.log_receipt": "Log into a receipt",
    "scan.edit_master": "Edit product master",
    "scan.add_to_print": "Add to print sheet",
    "scan.added_to_print": "Added to the print sheet",
    "scan.rescan": "Scan another",
    // retrofit
    "supply.mode.ready_stock": "Ready stock",
    "supply.mode.made_to_order": "Made to order",
    "supply.mode.both": "Both",
    "supply.mode.discontinued": "Discontinued",
    "avail.in_stock": "In stock",
    "avail.limited": "Limited",
    "avail.on_order_ready": "Available on order",
    "avail.made_to_order": "Made to order",
    "avail.sold_out": "Sold out",
    "avail.discontinued": "No longer available",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];

export function t(key: StringKey): string {
  return STRINGS.en[key] ?? key;
}
