-- 0063 — retire a product without deleting it (Ansh, 22 Sep).
--
-- "add an option to set a product as discontinued. Products once discontinued
--  will not be shown in studio by default. Add a button to show these when
--  needed just in case, along with a product-level restore option."
--
-- A stamp, not a boolean. Who and when are the questions anyone asks about a
-- retired product six months later, and a `discontinued boolean` answers
-- neither — the same reason order bills are cancelled and kept rather than
-- deleted. Restoring clears the stamp, so the column is also the restore.
--
-- Deliberately on designs, not on wholesale_products: Studio's unit is the
-- (base, colour) design group, which is what the owner means by "a product",
-- and retiring one size of a garment is not a thing anyone wants to express.
-- Stock, orders and billing all key off wholesale_products and are untouched —
-- a discontinued garment still hanging in the showroom can still be sold at
-- the counter, exactly as an unpushed one can (0062).

alter table designs add column if not exists discontinued_at  timestamptz;
alter table designs add column if not exists discontinued_by   text;
alter table designs add column if not exists discontinued_note text;

comment on column designs.discontinued_at is
  'Set when the product is retired; null means active. The studio board hides these unless "Discontinued" is switched on. Clearing it is the restore.';

-- Partial, because the interesting query is "the few that ARE retired" — the
-- board's default is the complement and reads the whole table anyway.
create index if not exists designs_discontinued_idx
  on designs (discontinued_at) where discontinued_at is not null;
