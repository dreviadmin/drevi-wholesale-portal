-- Vendor / procurement data per product, synced from the Wholesale Master
-- sheet (IDENTITY: Vendor SKU / Vendor ID / Vendor Name; STOCK: Last Cost /
-- Last Receipt Date). Kept in its OWN table — never on wholesale_products —
-- because cost price is procurement-sensitive and buyer-facing pages
-- select("*") from wholesale_products. Only the admin dashboard reads this.

create table if not exists public.product_vendor_info (
  sku               text primary key,
  vendor_name       text,
  vendor_id         text,
  vendor_sku        text,
  last_cost         numeric not null default 0,
  last_receipt_date text,
  updated_at        timestamptz not null default now()
);

alter table public.product_vendor_info enable row level security;
