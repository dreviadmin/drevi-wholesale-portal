-- 0050 — the wholesale price gets the multiplier + override the MRP has had
-- since 0020 (Ansh, 14 Sep: "Add multiplier and override option feature to
-- wholesale price as well as done for retail price so that one does not have
-- to calculate manually").
--
-- GRAIN is the design, deliberately. wholesale_products.auto_wholesale /
-- wholesale_override (0038) are the per-SKU pair from the sheet era and stay
-- dead: the 12 Sep studio consolidation settled on ONE buyer-facing wholesale
-- price for every size of a design, and reviving those columns would re-split
-- exactly what it merged.
--
-- The buyer-facing number is still wholesale_products.wholesale_price (locked
-- against the 10-minute sheet sync when saved). These three columns are the
-- working-out that produces it, mirroring auto_mrp / mrp_override.
--
-- Honest about the base: both autos stand on product_vendor_info.last_cost,
-- which the sheet sync rewrites with NO lock of its own. The cost can move
-- under a user between visits, so the on-screen preview is not a promise.
-- That is pre-existing for the MRP and is not solved here — the override is
-- still the only way to pin a number.
--
-- NOT DONE HERE: effective_wholesale in products_master_view. 0020 builds that
-- view with CREATE OR REPLACE VIEW and `npm run db:migrate` re-applies every
-- file on every pass, so a view carrying extra columns makes 0020's own
-- re-run fail with "cannot drop columns from view". Exposing it needs 0020
-- itself to switch to drop + create; see the handover note.
--
-- Reversal:
--   alter table designs drop column if exists wholesale_multiplier;
--   alter table designs drop column if exists auto_wholesale;
--   alter table designs drop column if exists wholesale_override;
--
-- Idempotent: safe to re-run.

alter table designs add column if not exists wholesale_multiplier numeric;
alter table designs add column if not exists auto_wholesale numeric;
alter table designs add column if not exists wholesale_override numeric;

-- Seed the multiplier so the editor opens on a number instead of a blank box.
-- 1.2 is the live book, not a guess: across the 194 priced SKUs that also
-- carry a cost, wholesale_price / last_cost has a median of 1.202 and sits at
-- 1.20 from the 25th to the 75th percentile.
update designs set wholesale_multiplier = 1.2 where wholesale_multiplier is null;

-- Turning the feature on must move no money. Where every size of a design
-- already agrees on one hand-set price, that price becomes the override, so
-- the effective wholesale equals what buyers pay today until a human changes
-- it. Designs whose sizes are priced apart get NO override — the editor warns
-- and leaves them alone rather than flattening a deliberate spread.
update designs d
set wholesale_override = src.price
from (
  select d2.id, min(w.wholesale_price) as price
  from designs d2
  join wholesale_products w
    on w.sku like d2.base_sku || '-%' and upper(w.sku) like '%-' || upper(d2.color)
  where w.wholesale_price > 0
  group by d2.id
  having min(w.wholesale_price) = max(w.wholesale_price)
) src
where src.id = d.id and d.wholesale_override is null;
