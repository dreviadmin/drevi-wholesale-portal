-- ============================================================================
-- Allow duplicate emails/phones across buyer rows (Ansh, 4 Jul 2026): field
-- staff often reuse a placeholder email at capture time. Email uniqueness is
-- enforced in application code ONLY at credential activation (an email is a
-- login identity, so two credentialed buyers can't share one). Idempotent.
-- ============================================================================

alter table public.buyers drop constraint if exists buyers_email_key;
