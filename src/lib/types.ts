// Shared domain + database row types. Mirrors the Supabase schema (spec §4.3).

export type StockState = "ready" | "limited" | "made_to_order" | "sold_out";

export type BuyerStatus = "pending" | "active" | "suspended" | "rejected";
export type BuyerSource = "inquiry_form" | "exhibition" | "manual_admin";
export type StaffRole = "super_admin" | "admin" | "staff";
export type OrderStatus = "submitted" | "confirmed" | "fulfilled" | "cancelled";
export type OrderSource = "portal_self_service" | "exhibition";

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
  | "account_rejected";

export interface WholesaleProduct {
  sku: string;
  title: string | null;
  description: string | null;
  category: string | null;
  sub_category: string | null;
  color: string | null;
  primary_fabric: string | null;
  wholesale_price: number;
  wholesale_visible: boolean;
  min_order_qty: number | null;
  restockable: boolean;
  restock_days: number | null;
  current_qty: number;
  image_urls: string[] | null;
  shopify_product_id: string | null;
  shopify_live_url: string | null;
  synced_at: string | null;
  images_fetched_at: string | null;
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
  unit_price: number;
  qty: number;
  stock_state: StockState;
  restock_days: number | null;
}

export interface Order {
  id: string;
  order_number: string;
  buyer_id: string;
  status: OrderStatus;
  source: OrderSource;
  assisted_by: string | null;
  exhibition_event: string | null;
  items: OrderItem[];
  total_amount: number;
  notes: string | null;
  pdf_url: string | null;
  pdf_sent_via: string | null;
  pdf_sent_at: string | null;
  submitted_at: string;
  confirmed_at: string | null;
}
