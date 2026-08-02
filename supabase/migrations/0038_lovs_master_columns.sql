-- 0038 · Productionization (Ansh's plan §2) — LoVs + the master-sheet columns.
--
-- LoVs: one editable table backing every list the portal offers (categories,
-- sub-categories, colours, sizes, fabrics, occasions). Seeded by the Reference
-- importer; editable in the portal (decision 5).
--
-- Master columns (decision 3 — preserve per-SKU pricing):
--   designs gains the design-level fields (secondary fabric/handwork,
--   occasion hints, meta title/description);
--   wholesale_products gains the per-SKU pricing provenance
--   (auto/override wholesale + auto/override MRP — the FINAL values remain
--   wholesale_price and product_vendor_info.retail_price).
--
-- Reversal:
--   drop table if exists lovs;
--   alter table designs drop column if exists secondary_fabric;
--   alter table designs drop column if exists secondary_handwork;
--   alter table designs drop column if exists occasion_hints;
--   alter table designs drop column if exists meta_title;
--   alter table designs drop column if exists meta_description;
--   alter table wholesale_products drop column if exists auto_wholesale;
--   alter table wholesale_products drop column if exists wholesale_override;
--   alter table wholesale_products drop column if exists auto_mrp;
--   alter table wholesale_products drop column if exists mrp_override;
--
-- Idempotent: safe to re-run.

create table if not exists lovs (
  id uuid primary key default gen_random_uuid(),
  list text not null check (list in ('category','sub_category','color','size','fabric','occasion')),
  code text not null,
  label text not null default '',
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (list, code)
);
alter table lovs enable row level security;

alter table designs add column if not exists secondary_fabric text;
alter table designs add column if not exists secondary_handwork text;
alter table designs add column if not exists occasion_hints text;
alter table designs add column if not exists meta_title text;
alter table designs add column if not exists meta_description text;

alter table wholesale_products add column if not exists auto_wholesale numeric;
alter table wholesale_products add column if not exists wholesale_override numeric;
alter table wholesale_products add column if not exists auto_mrp numeric;
alter table wholesale_products add column if not exists mrp_override numeric;
