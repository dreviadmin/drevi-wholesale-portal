-- 0037 · Productionization (Ansh's plan §2) — GST on goods receipts.
--
--   gst_mode       'kaccha' (no bill) | 'pakka' (GST bill)
--   gst_rate       5 or 18, meaningful for pakka only
--   gst_inclusive  true  → entered prices already contain GST
--                  false → GST was paid on top of entered prices
--
-- Costing decision (Ansh, 2 Aug): pricing math (auto-MRP / auto-wholesale)
-- runs on the EX-GST cost for now — input credit is claimed on pakka bills.
--
-- Reversal:
--   alter table goods_receipts drop column if exists gst_mode;
--   alter table goods_receipts drop column if exists gst_rate;
--   alter table goods_receipts drop column if exists gst_inclusive;
--
-- Idempotent: safe to re-run.

alter table goods_receipts add column if not exists gst_mode text check (gst_mode in ('kaccha','pakka'));
alter table goods_receipts add column if not exists gst_rate numeric;
alter table goods_receipts add column if not exists gst_inclusive boolean;
