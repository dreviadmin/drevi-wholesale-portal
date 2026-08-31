-- Stage 8 (build guide §12.2, guide file 0018 → repo 0020 per DECISIONS):
-- app-owned pricing on designs + a sheet-shaped view for the transition.
-- The sheet still owns live prices until the ANSH-07 cutover — these columns
-- let the editor work in parallel and let /api/dev/master-diff compare.

alter table designs add column if not exists auto_mrp numeric;
alter table designs add column if not exists mrp_override numeric;
alter table designs add column if not exists markup_multiplier numeric;

-- One row per size variant, joined to its design group — anything still
-- expecting sheet-shaped data reads this instead of raw tables.
create or replace view products_master_view as
select
  w.sku,
  d.base_sku,
  d.color,
  w.title,
  w.category,
  w.sub_category,
  d.fabric,
  d.handwork,
  d.origin,
  d.specs_verified,
  d.tier,
  d.markup_multiplier,
  d.auto_mrp,
  d.mrp_override,
  coalesce(d.mrp_override, d.auto_mrp) as effective_mrp,
  w.wholesale_price,
  w.current_qty,
  w.wholesale_visible,
  pvi.last_cost,
  pvi.retail_price as sheet_retail_price,
  pvi.vendor_name,
  pvi.vendor_sku
from wholesale_products w
left join designs d
  on w.sku like d.base_sku || '-%'
 and upper(w.sku) like '%-' || upper(d.color)
left join product_vendor_info pvi on pvi.sku = w.sku;

-- Backfill: seed auto_mrp from current cost × default multiplier where a
-- cost exists and nothing is set yet (multiplier: hero 3.0, standard 2.5;
-- rounded to the nearest ₹99 price point).
update designs d
set markup_multiplier = case when d.tier = 'hero' then 3.0 else 2.5 end
where d.markup_multiplier is null;

update designs d
set auto_mrp = greatest(99, round((src.cost * d.markup_multiplier) / 100.0) * 100 - 1)
from (
  select d2.id, max(pvi.last_cost) as cost
  from designs d2
  join wholesale_products w on w.sku like d2.base_sku || '-%' and upper(w.sku) like '%-' || upper(d2.color)
  join product_vendor_info pvi on pvi.sku = w.sku
  where pvi.last_cost > 0
  group by d2.id
) src
where src.id = d.id and d.auto_mrp is null and src.cost > 0;
