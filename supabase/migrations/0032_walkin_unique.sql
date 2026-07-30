-- 0032 · UX sprint review — at most ONE open walk-in counter session.
--
-- /admin/in-store does find-or-create; two staff hitting it simultaneously
-- could both insert. The partial unique index makes the second insert fail,
-- and the page then re-selects the winner.
--
-- Reversal: drop index if exists exhibition_sessions_walkin_open_key;
-- Idempotent: safe to re-run.

create unique index if not exists exhibition_sessions_walkin_open_key
  on exhibition_sessions (session_type)
  where session_type = 'in_store' and ended_at is null and event_name = 'Walk-in counter';
