-- ============================================================================
-- Billing pass: order-level discount (percent or absolute), applied to the
-- subtotal before tax. Per-line price overrides live inside the items
-- snapshot (unit_price + original_price), no schema change needed. Idempotent.
-- ============================================================================

alter table public.orders
  add column if not exists discount_type text,                       -- 'percent' | 'absolute'
  add column if not exists discount_value numeric(12,2),
  add column if not exists discount_amount numeric(12,2) not null default 0;
