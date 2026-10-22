-- 0076 — Retail compare-at price per design.
--
-- Ansh, 22 Oct 2026: "Add an option to set retail compare at price for each
-- product in studio ... This change shall also be reflected in the tags
-- printed."
--
-- The "was" price shown struck through above the MRP: on the price tag, and as
-- the variant compareAtPrice when Studio pushes the design to Shopify. One per
-- design (base SKU + colour), like mrp_override; sizes share it. NULL = none.
-- It only shows while it is ABOVE the MRP (retail-price-core.ts effectiveCompareAt),
-- so an MRP raised past it later simply stops showing it rather than printing
-- a "was" price lower than the price.
--
-- Additive and idempotent. REVERSAL: alter table public.designs drop column compare_at_price;

alter table public.designs add column if not exists compare_at_price numeric(10,2);

alter table public.designs drop constraint if exists designs_compare_at_price_positive;
alter table public.designs add constraint designs_compare_at_price_positive
  check (compare_at_price is null or compare_at_price > 0);

comment on column public.designs.compare_at_price is
  'Retail compare-at ("was") price, shown struck through above the MRP on tags and sent to Shopify as compareAtPrice. Ignored while not above the MRP. NULL = none. (0076)';
