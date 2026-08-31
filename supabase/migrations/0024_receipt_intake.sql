-- Retrofit R1 §3.3 — receipts, designs, provenance.
--
-- REVERSAL: drop the added columns on goods_receipts / goods_receipt_lines /
--   designs and the grl_design_idx index. entry_date backfill is derived from
--   created_at, so it can be recomputed at any time.
--
-- entry_date is immutable after insert — enforced in the API (§3.3), not a
-- trigger, so an admin correction path remains possible without DDL.

alter table goods_receipts add column if not exists entry_date date;
update goods_receipts set entry_date = (created_at at time zone 'Asia/Kolkata')::date
 where entry_date is null;
alter table goods_receipts alter column entry_date set not null;
alter table goods_receipts alter column entry_date
  set default (now() at time zone 'Asia/Kolkata')::date;

alter table goods_receipt_lines add column if not exists vendor_sku text;
alter table goods_receipt_lines add column if not exists design_id uuid references designs(id);
alter table goods_receipt_lines add column if not exists created_design boolean not null default false;

alter table designs add column if not exists origin_source text not null default 'sheet';
do $$ begin
  alter table designs add constraint designs_origin_source_check check (origin_source in ('sheet', 'app'));
exception when duplicate_object then null; end $$;
alter table designs add column if not exists drive_folder_id text;
alter table designs add column if not exists ident_image_id uuid references design_images(id);
alter table designs add column if not exists vendor_id uuid references vendors(id);
alter table designs add column if not exists vendor_sku text;
alter table designs add column if not exists first_receipt_id uuid references goods_receipts(id);

create index if not exists grl_design_idx on goods_receipt_lines (design_id);

-- Backfill (best effort, reported by scripts/retrofit-backfill.mjs):
-- link existing receipt lines to designs by parsing upper(sku) into (base, colour).
update goods_receipt_lines l
   set design_id = d.id
  from designs d
 where l.design_id is null
   and upper(l.sku) like d.base_sku || '-%'
   and upper(l.sku) like '%-' || upper(d.color);

-- designs.vendor_id / vendor_sku from the most recent linked line.
update designs d
   set vendor_id = src.vendor_id,
       vendor_sku = coalesce(d.vendor_sku, src.vendor_sku)
  from (
    select distinct on (l.design_id) l.design_id, r.vendor_id, l.vendor_sku
      from goods_receipt_lines l
      join goods_receipts r on r.id = l.receipt_id
     where l.design_id is not null
     order by l.design_id, r.receipt_date desc, r.created_at desc
  ) src
 where src.design_id = d.id and d.vendor_id is null;
