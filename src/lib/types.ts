// Shared domain + database row types. Mirrors the Supabase schema (spec §4.3).

export type StockState = "ready" | "limited" | "made_to_order" | "sold_out";

export type BuyerStatus = "pending" | "active" | "suspended" | "rejected";
export type BuyerSource = "inquiry_form" | "exhibition" | "manual_admin";
export type StaffRole = "super_admin" | "admin" | "staff";
// UX sprint (29 Jul): full logistics lifecycle. 'fulfilled' is the legacy
// terminal state on old rows; new flows end at 'delivered'.
export type OrderStatus = "submitted" | "confirmed" | "packed" | "out_for_delivery" | "delivered" | "fulfilled" | "cancelled";
export type OrderSource = "portal_self_service" | "exhibition" | "in_store";
export type TaxMode = "none" | "inclusive" | "exclusive";
export type SessionType = "exhibition" | "in_store";

// The Postgres enum, in the order the migrations grew it (0001, 0010, 0014,
// 0015, 0016, 0018, 0019, 0047). An insert with a value missing from the
// database enum fails at the database, so this union has to stay complete —
// 0014's and 0015's values were never added here, which is why callers had
// started casting their way past it.
export type AuditEventType =
  | "credential_created"
  | "credential_viewed"
  | "credential_regenerated"
  | "credential_changed"
  | "credential_shared"
  | "login_success"
  | "login_failed"
  | "account_suspended"
  | "account_reactivated"
  | "account_rejected"
  | "catalog_edit"
  | "vendor_created"
  | "vendor_updated"
  | "receipt_created"
  | "receipt_updated"
  | "receipt_deleted"
  | "staff_created"
  | "staff_deactivated"
  | "staff_reactivated"
  | "buyer_created"
  | "studio_tier_set"
  | "studio_portal_toggled"
  | "studio_candidate_approved"
  | "studio_candidate_rejected"
  | "studio_published"
  | "buyer_profile_updated"
  | "buyer_change_requested"
  | "buyer_change_approved"
  | "buyer_change_rejected"
  | "document_party_recaptured"
  | "document_date_corrected"
  | "order_payment_recorded"
  | "return_credit_note_raised"
  | "return_credit_note_voided"
  | "credit_settled"
  | "order_bill_cancelled";

/**
 * The buyer identity frozen onto a document at its issue date (0047) — carried
 * by orders, order_bills and credit_notes alike.
 *
 * Optional because a row inserted by a pre-0047 instance during the deploy
 * window carries none. Nothing should read these fields directly to decide what
 * to PRINT: resolveDocumentParty in @/lib/buyer-snapshot owns that branch, and
 * this module stays free of server-only imports so client surfaces can keep
 * importing it.
 */
export interface DocumentBuyerSnapshot {
  buyer_business_name?: string | null;
  buyer_owner_name?: string | null;
  buyer_phone?: string | null;
  buyer_city?: string | null;
  buyer_gstin?: string | null;
  buyer_address?: string | null;
  /** Null means "no snapshot on this row" — the only flag the render path branches on. */
  buyer_snapshot_at?: string | null;
  buyer_snapshot_source?: "issue" | "issue_backdated" | "queued" | "backfill" | "recapture" | null;
}

// Every column a BUYER surface may select. select("*") on buyer pages ships
// internal fields (location, cost provenance) into the page payload — caught
// live on 2 Aug when "Rack B2" appeared in the product page's RSC stream.
export const BUYER_PRODUCT_COLUMNS =
  "sku, title, description, category, sub_category, color, primary_fabric, wholesale_price, wholesale_visible, buyer_visible, min_order_qty, current_qty, restockable, restock_days, image_urls, hsn";

export interface WholesaleProduct {
  hsn?: string | null;
  sku: string;
  title: string | null;
  description: string | null;
  category: string | null;
  sub_category: string | null;
  color: string | null;
  primary_fabric: string | null;
  wholesale_price: number;
  /** The sheet/ops flag: staff may sell this. Every billing screen reads it. */
  wholesale_visible: boolean;
  /** Buyers may SEE this in /catalog. Written only by a Studio wholesale push
   *  or by staff in Manage Catalog — never by the sheet sync (0062). */
  buyer_visible: boolean;
  min_order_qty: number | null;
  restockable: boolean;
  restock_days: number | null;
  current_qty: number;
  image_urls: string[] | null;
  shopify_product_id: string | null;
  shopify_live_url: string | null;
  synced_at: string | null;
  images_fetched_at: string | null;
  // Fields an admin edited in Manage Catalog — the sheet sync leaves these alone.
  locked_fields?: string[];
}

export interface Buyer {
  id: string;
  email: string | null;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  gstin: string | null;
  address: string | null;
  transport_details: string | null;
  broker_details: string | null;
  other_details: string | null;
  card_image_path: string | null;
  status: BuyerStatus;
  source: BuyerSource;
  encrypted_password: string | null;
  approved_by: string | null;
  approved_at: string | null;
  captured_by: string | null;
  captured_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  notes: string | null;
  created_at: string;
}

export interface StaffUser {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
  active: boolean;
  created_at: string;
}

export interface OrderItem {
  sku: string;
  title: string;
  /** GST classification, snapshotted from the product at billing (30 Jul). */
  hsn?: string | null;
  unit_price: number;
  qty: number;
  stock_state: StockState;
  restock_days: number | null;
  image_url?: string | null;
  special_request?: boolean;
  // Set when staff overrode the wholesale price at billing time.
  original_price?: number;
  // GST bill-split: when a piece is billed as N cheaper units (to stay under a
  // tax slab), qty/unit_price hold the BILLED figures and actual_qty keeps the
  // real piece count. Real per-piece price = qty*unit_price / actual_qty.
  actual_qty?: number;
  // Billed units already returned against a credit note. The credit note rows
  // are the audit trail; this is the reservation the return cap is won on
  // (written only through patchOrderLine's lines_rev CAS).
  returned_qty?: number;
  // Free-typed line for a piece not (yet) in the portal catalog — never
  // validated against wholesale_products.
  custom?: boolean;
  // Line-level confirmation (Ansh, 18 Aug). Absent = legacy line that follows
  // the order status; 'hold' carries an availability note for the customer;
  // 'pending' is EXPLICIT un-confirmation (a null on a confirmed order would
  // derive straight back to confirmed).
  line_state?: "confirmed" | "hold" | "pending" | null;
  hold_note?: string | null;
  // Bill id once this line has been billed (order_bills.id) — a billed line is
  // immutable from the line-state actions.
  billed_in?: string | null;
  // True while this line's stock is OUT because of this order — set by
  // whichever path moved it (line confirm or whole-order confirm), cleared
  // when it comes back. postOrderMovements keys off it, so the two paths can
  // never double-move a line.
  stock_moved?: boolean;
}

/** A retail (MRP) sale to a walk-in customer (0043) — its own stream. */
export interface RetailBill {
  id: string;
  bill_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  items: OrderItem[];
  subtotal: number;
  discount_type: DiscountType | null;
  discount_value: number | null;
  discount_amount: number;
  tax_mode: TaxMode;
  tax_rate: number | null;
  tax_amount: number;
  total: number;
  payment_method: string | null;
  bill_date: string;
  pdf_url: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_by: string | null;
  created_at: string;
}

/** One generated bill against an order (0041) — lines are snapshotted. */
export interface OrderBill extends DocumentBuyerSnapshot {
  id: string;
  order_id: string;
  bill_number: string;
  /** Set when the invoice is cancelled (0060) — the row is kept, never deleted. */
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  cancel_reason?: string | null;
  seq: number;
  items: OrderItem[];
  subtotal: number;
  discount_amount: number;
  tax_mode: TaxMode;
  tax_rate: number | null;
  tax_amount: number;
  total: number;
  advance_applied: number;
  bill_date: string;
  pdf_url: string | null;
  created_by: string | null;
  created_at: string;
}

export type DiscountType = "percent" | "absolute";

export interface Order extends DocumentBuyerSnapshot {
  id: string;
  order_number: string;
  buyer_id: string;
  status: OrderStatus;
  source: OrderSource;
  assisted_by: string | null;
  exhibition_event: string | null;
  items: OrderItem[];
  total_amount: number;
  discount_type: DiscountType | null;
  discount_value: number | null;
  discount_amount: number;
  tax_mode: TaxMode;
  tax_rate: number | null;
  tax_amount: number;
  advance_amount: number;
  /** Wallet credit settled against this order — maintained by the apply_credit RPC. */
  credit_applied?: number;
  payment_method: string | null;
  payment_notes: string | null;
  notes: string | null;
  pdf_url: string | null;
  pdf_sent_via: string | null;
  pdf_sent_at: string | null;
  submitted_at: string;
  confirmed_at: string | null;
  packed_at: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  courier: string | null;
  tracking_number: string | null;
  tracking_note: string | null;
  tracking_image_ref: string | null;
}
