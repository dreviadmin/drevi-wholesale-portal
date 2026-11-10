-- 0079 — An index the stock ledger's own reads can use.
--
-- Every stock change re-reads that SKU's whole movement history to work out
-- the new quantity (stock-ledger.ts movementsFor: where sku = <upper-cased
-- SKU> order by created_at). The only index on stock_movements (0026,
-- sm_sku_idx) is on upper(sku), so it never matches a plain sku = … filter
-- and each of those reads scans the whole table, a little slower every day.
--
-- This adds a plain (sku, created_at) index that matches the query as the app
-- writes it. sm_sku_idx stays for the SQL that compares upper(sku).
--
-- No code change goes with this file and no code depends on it: the app runs
-- the same before and after, only faster after. Safe to apply at any time.
-- The build takes a brief write lock on stock_movements while it runs.
--
-- Additive and idempotent. REVERSAL: drop index if exists sm_sku_created_idx;

create index if not exists sm_sku_created_idx on stock_movements (sku, created_at);
