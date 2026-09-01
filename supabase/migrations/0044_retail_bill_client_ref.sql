-- 0044 — retail-bill idempotency (review fix, 31 Aug).
--
-- A double-tap on Save (or a flaky network retrying the action) must resolve
-- to ONE bill and ONE set of stock movements. The form mints a client_ref per
-- bill attempt; the unique index makes the second insert collide, and the
-- action returns the existing bill instead of double-charging stock — the
-- same pattern orders use.

alter table retail_bills add column if not exists client_ref uuid;
create unique index if not exists rb_client_ref_unique on retail_bills (client_ref) where client_ref is not null;
