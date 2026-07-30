-- 0034 · Ansh (30 Jul): HSN codes on billing. Dev AND prod.
--
-- Per-product HSN (GST classification, e.g. 6204 for women's suits/lehengas).
-- Synced from the Wholesale Master's optional "HSN" column, editable in Manage
-- Catalog, snapshotted onto order items at billing, printed on the invoice.
--
-- Reversal: alter table wholesale_products drop column if exists hsn;
-- Idempotent: safe to re-run.

alter table wholesale_products add column if not exists hsn text;
