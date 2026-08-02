-- 0035 · Ansh (31 Jul): 6204 is the house default HSN — women's garments only
-- for now. Backfill every product and every order line that has no code.
-- Explicitly-set differing codes are untouched.
--
-- Reversal: none needed — this only fills blanks; re-clearing would lose
-- nothing but the default.
--
-- Idempotent: fills only null/empty values.

update wholesale_products set hsn = '6204' where hsn is null or hsn = '';

update orders
set items = (
  select jsonb_agg(
    case
      when item->>'hsn' is null or item->>'hsn' = '' then item || '{"hsn":"6204"}'::jsonb
      else item
    end
  )
  from jsonb_array_elements(items) item
)
where items is not null and jsonb_array_length(items) > 0;
