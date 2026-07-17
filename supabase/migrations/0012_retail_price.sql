-- Retail price (sheet "Final MRP") for the shop-floor Retail Price Check.
-- Lives on product_vendor_info (synced sheet extras, admin-server reads only)
-- so it covers every sheet row — including garments hidden from the wholesale
-- portal that still hang in the retail shop.

alter table public.product_vendor_info
  add column if not exists retail_price numeric not null default 0;
