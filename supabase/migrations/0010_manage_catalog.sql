-- 0010 — Manage Catalog: manual edits that survive the sheet sync.
--
-- locked_fields: column names an admin has edited by hand in /admin/manage-
-- catalog. The sync preserves the existing value for every locked field
-- instead of overwriting it from the sheet. Unlocking a field hands control
-- back to the sheet on the next sync.
--
-- sync_ignored_skus: sheet SKUs the sync must skip entirely. Written when an
-- admin renames a product's SKU (the sheet still carries the old one — without
-- this, the next sync would resurrect it as a duplicate row).

alter table public.wholesale_products
  add column if not exists locked_fields text[] not null default '{}';

-- New audit event for Manage Catalog edits (enum from 0001).
alter type public.audit_event_type add value if not exists 'catalog_edit';

create table if not exists public.sync_ignored_skus (
  sku        text primary key,
  reason     text,
  created_at timestamptz not null default now()
);
