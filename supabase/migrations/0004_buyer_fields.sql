-- ============================================================================
-- Improvements pass — buyer optional-core + operational fields.
-- email becomes nullable (a captured buyer may not have one yet; required at
-- credential activation). Adds address, transport_details, broker_details,
-- other_details. Idempotent.
-- ============================================================================

alter table public.buyers alter column email drop not null;

alter table public.buyers
  add column if not exists address text,
  add column if not exists transport_details text,
  add column if not exists broker_details text,
  add column if not exists other_details text;
