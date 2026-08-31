-- Retrofit R1 §3.4 — supplier capability.
--
-- REVERSAL: drop the added columns on designs and goods_receipt_lines. All are
--   optional; a design with nothing recorded behaves exactly as before.

-- current truth, on the design
alter table designs add column if not exists supply_mode text;
do $$ begin
  alter table designs add constraint designs_supply_mode_check
    check (supply_mode in ('ready_stock', 'made_to_order', 'both', 'discontinued'));
exception when duplicate_object then null; end $$;
alter table designs add column if not exists vendor_stock_qty int;
alter table designs add column if not exists making_days int;
alter table designs add column if not exists making_moq int;
alter table designs add column if not exists delivery_days int;
do $$ begin
  alter table designs add constraint designs_vendor_stock_qty_check check (vendor_stock_qty >= 0);
  alter table designs add constraint designs_making_days_check    check (making_days >= 0);
  alter table designs add constraint designs_making_moq_check     check (making_moq > 0);
  alter table designs add constraint designs_delivery_days_check  check (delivery_days >= 0);
exception when duplicate_object then null; end $$;
alter table designs add column if not exists supply_note text;
alter table designs add column if not exists supply_updated_at timestamptz;
alter table designs add column if not exists supply_updated_by text;

-- the same set as a dated observation, for history
alter table goods_receipt_lines add column if not exists supply_mode text;
alter table goods_receipt_lines add column if not exists vendor_stock_qty int;
alter table goods_receipt_lines add column if not exists making_days int;
alter table goods_receipt_lines add column if not exists making_moq int;
alter table goods_receipt_lines add column if not exists delivery_days int;
alter table goods_receipt_lines add column if not exists supply_note text;
