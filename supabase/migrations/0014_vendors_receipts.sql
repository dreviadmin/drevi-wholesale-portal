-- Phase 1 (Part B): Vendors & Goods Receipts — record-keeping only.
-- Captures what came in from which vendor at what cost. Deliberately writes
-- NOTHING to wholesale_products or product_vendor_info; cost/stock authority
-- moves here only at the Phase 3 master cutover.

create table if not exists public.vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text, whatsapp text, city text, address text, gstin text,
  notes      text default '',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists vendors_name_key on public.vendors (lower(name));

create table if not exists public.goods_receipts (
  id              uuid primary key default gen_random_uuid(),
  receipt_number  text not null unique,          -- GR-YYYYMMDD-NNN (next_order_number machinery)
  vendor_id       uuid not null references public.vendors(id),
  receipt_date    date not null default (now() at time zone 'Asia/Kolkata')::date,
  bill_photo_path text,                          -- private 'receipt-photos' bucket
  bill_amount     numeric,                       -- as printed on the vendor bill (optional)
  notes           text default '',
  client_ref      uuid unique,                   -- idempotency, same pattern as orders
  created_by      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists gr_vendor_idx on public.goods_receipts (vendor_id);
create index if not exists gr_date_idx   on public.goods_receipts (receipt_date desc);

create table if not exists public.goods_receipt_lines (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references public.goods_receipts(id) on delete cascade,
  sku         text not null,                     -- variant SKU, uppercased; unknown allowed
  description text default '',
  qty         int not null check (qty > 0),
  unit_cost   numeric not null check (unit_cost >= 0),
  position    int not null default 0
);
create index if not exists grl_receipt_idx on public.goods_receipt_lines (receipt_id);
create index if not exists grl_sku_idx     on public.goods_receipt_lines (upper(sku));

-- Admin-only data: RLS enabled with no policies denies anon and authenticated
-- users; every access goes through admin-gated server routes (service role).
alter table public.vendors enable row level security;
alter table public.goods_receipts enable row level security;
alter table public.goods_receipt_lines enable row level security;

-- Audit events for the new module (auth_audit_log carries them like
-- credential and catalog events; SKU generation itself needs no audit —
-- created_by on the registry row is the trail).
alter type audit_event_type add value if not exists 'vendor_created';
alter type audit_event_type add value if not exists 'vendor_updated';
alter type audit_event_type add value if not exists 'receipt_created';
alter type audit_event_type add value if not exists 'receipt_updated';
alter type audit_event_type add value if not exists 'receipt_deleted';
