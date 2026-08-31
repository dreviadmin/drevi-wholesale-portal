-- 0039 · Ansh (2 Aug): track where each variant physically lives — free-text
-- note for now ("Rack B2", "Godown shelf 3", "CMAI stock box").
--
-- Portal-owned: the sheet has no such column and the sync never writes it.
-- Internal only — never serialised to buyer surfaces.
--
-- Reversal: alter table wholesale_products drop column if exists location;
-- Idempotent: safe to re-run.

alter table wholesale_products add column if not exists location text;
