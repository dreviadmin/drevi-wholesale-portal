-- 0062 — the buyer catalog becomes a Studio decision (Ansh, 22 Sep).
--
-- "Wholesale catalog should contain only the Items pushed to wholesale via
--  studio. This is what the buyers see using their creds. The billing still
--  uses products from Studio directly ... it must not stop billing - even for
--  unpushed products."
--
-- WHY A NEW COLUMN RATHER THAN REUSING wholesale_visible.
--
-- wholesale_visible is doing two jobs. The buyer catalog reads it as "buyers
-- may see this"; six billing and shop-floor screens read it as "staff may sell
-- this" — the exhibition/in-store wizard, its submit guard, the order editor's
-- add-line guard and its picker, wholesale price check, and the sold-out
-- inbox. On prod 289 of 303 SKUs are visible and only 106 were ever pushed
-- from Studio, so narrowing that one flag to mean "pushed" would take 183
-- garments out of the booth's scanner and out of the order editor at the same
-- moment it took them out of the catalog. In-store and exhibition are the only
-- billing paths that have ever been used (44 of the 46 orders on prod).
--
-- So visibility splits in two. wholesale_visible keeps its existing meaning and
-- every existing reader keeps working untouched; buyer_visible is new, starts
-- false, and is written by exactly one thing: a wholesale push from Studio.
-- The 10-minute sheet cron cannot touch it — sync.ts never names this column,
-- and an upsert that does not name a column leaves it alone. That matters:
-- wholesale_visible is hardcoded true at sync.ts:220 for every sheet row, all
-- 183 of the unpushed rows are unlocked, and 182 of them were re-stamped
-- within the hour. Narrowing the old flag would have been undone by the cron
-- before anyone noticed.

alter table wholesale_products
  add column if not exists buyer_visible boolean not null default false;

comment on column wholesale_products.buyer_visible is
  'Buyers may see this in /catalog. Set ONLY by a Studio wholesale push (publishWholesale) or by staff in Manage Catalog. Never written by the sheet sync. Distinct from wholesale_visible, which stays the sheet/ops flag every billing screen reads.';

create index if not exists wp_buyer_visible_idx
  on wholesale_products (buyer_visible) where buyer_visible;

-- Backfill: on for every variant of a design group whose wholesale target is
-- live. The group key is derived exactly as parseSku does in the app — the
-- first FOUR hyphen parts are the base and the LAST part is the colour, which
-- is not the same as the fifth on any SKU carrying a size. Anything that does
-- not parse (DD-LEH-FLR-104 has four parts and no colour) simply stays false.
update wholesale_products wp
set buyer_visible = true
from designs d
join publish_targets pt
  on pt.design_id = d.id and pt.portal = 'wholesale' and pt.state = 'live'
where array_length(string_to_array(wp.sku, '-'), 1) >= 5
  and upper(array_to_string((string_to_array(wp.sku, '-'))[1:4], '-')) = upper(d.base_sku)
  and upper((string_to_array(wp.sku, '-'))[array_length(string_to_array(wp.sku, '-'), 1)]) = upper(d.color);
