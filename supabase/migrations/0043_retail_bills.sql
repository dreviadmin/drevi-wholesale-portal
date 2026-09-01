-- 0043 — retail billing (Ansh, 31 Aug).
--
-- The portal quoted retail prices (Final MRP) but couldn't SELL at them; the
-- shop's retail sales lived outside the system. Retail bills are their own
-- stream — a walk-in customer with an optional name/phone, not a wholesale
-- buyer — so they get their own table and an RB-YYYYMMDD-NNN number from the
-- same atomic counter, and stay out of the wholesale dashboards.
--
-- Stock: a retail sale posts a normal 'order' movement (ref_type
-- 'retail_bill'); voiding the bill posts the return. Bills are records —
-- voided ones keep their row and number, flagged with voided_at.

create table if not exists retail_bills (
  id uuid primary key default gen_random_uuid(),
  bill_number text not null unique,          -- RB-YYYYMMDD-NNN (bill_date's day)
  customer_name text,
  customer_phone text,
  items jsonb not null,                      -- [{sku,title,qty,unit_price,hsn,image_url}]
  subtotal numeric not null default 0,
  discount_type text check (discount_type in ('percent', 'absolute')),
  discount_value numeric,
  discount_amount numeric not null default 0,
  tax_mode text not null default 'none' check (tax_mode in ('none', 'inclusive', 'exclusive')),
  tax_rate numeric,
  tax_amount numeric not null default 0,
  total numeric not null default 0,
  payment_method text,
  bill_date date not null,
  pdf_url text,
  voided_at timestamptz,
  voided_by text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists rb_date_idx on retail_bills (bill_date desc, created_at desc);
alter table retail_bills enable row level security;
