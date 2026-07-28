-- Retrofit R1 §3.5 — movements with resettable baselines.
--
-- Goods IN are knowable from receipts; per-SKU SALE history for the past does
-- not exist. So the ledger supports a baseline reset ("as of now this SKU is N
-- pieces, ignore everything before") and all arithmetic runs forward from the
-- most recent reset. Nothing is ever deleted — earlier movements stay visible
-- as history, they simply stop contributing.
--
-- REVERSAL: drop table stock_movements. wholesale_products.current_qty is the
--   cached read and is untouched by this migration beyond seeding the opening
--   balances, so dropping the ledger leaves stock exactly as it stands.
--
-- NOTE (deviation, logged in DECISIONS): this repo's stock column is
-- wholesale_products.current_qty, not .stock.

create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  sku text not null,                          -- variant SKU, uppercase
  delta int not null default 0,               -- +in / -out; ignored when reason='reset'
  snapshot_qty int,                           -- absolute count; required when reason='reset'
  reason text not null check (reason in
    ('reset', 'receipt', 'order', 'manual', 'correction', 'shopify_sync')),
  ref_type text, ref_id uuid,                 -- receipt line id, order id, …
  note text, created_by text,
  created_at timestamptz not null default now(),
  constraint sm_reset_shape check (
    (reason = 'reset' and snapshot_qty is not null) or
    (reason <> 'reset' and snapshot_qty is null)
  )
);
create index if not exists sm_sku_idx on stock_movements (upper(sku), created_at desc);

alter table stock_movements enable row level security;

-- Seed one reset per SKU at its current cached quantity so the ledger starts
-- reconciled and nothing earlier is implied. Guarded: only for SKUs with no
-- movements yet, so a re-run adds nothing.
insert into stock_movements (sku, delta, snapshot_qty, reason, note, created_by)
select upper(w.sku), 0, coalesce(w.current_qty, 0), 'reset', 'migration opening balance', 'migration'
  from wholesale_products w
 where not exists (select 1 from stock_movements m where upper(m.sku) = upper(w.sku));
