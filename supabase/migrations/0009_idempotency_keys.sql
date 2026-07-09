-- 0009 — client idempotency keys for orders and captures.
--
-- The offline queue can replay a request that actually committed server-side but
-- whose response was lost (exhibition Wi-Fi drop, tab killed mid-drain). Without
-- a stable key, a replay mints a NEW order number and bills the buyer twice.
-- A client-generated UUID, carried on every submit and enforced unique, makes a
-- replay a no-op: the server returns the already-created row instead of a copy.

alter table public.orders  add column if not exists client_ref uuid;
alter table public.buyers  add column if not exists client_ref uuid;

-- Unique only among non-null refs (legacy rows and inquiry-form buyers have none).
create unique index if not exists orders_client_ref_key on public.orders(client_ref) where client_ref is not null;
create unique index if not exists buyers_client_ref_key on public.buyers(client_ref) where client_ref is not null;
