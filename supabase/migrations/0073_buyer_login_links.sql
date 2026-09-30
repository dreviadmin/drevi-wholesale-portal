-- 0073 — one-tap login links for buyers.
--
-- Meta will not approve a WhatsApp template that carries a username and
-- password (a login code belongs in its fixed-wording Authentication category,
-- which allows no video and no link). So the launch messages carry a button
-- instead: https://<portal>/go/<token>. Tapping it signs that buyer in.
--
-- One live link per buyer, independent of the password: regenerating or
-- changing the password leaves it working, so the button in the WhatsApp
-- message a buyer saved keeps working. Only "New link" (revoked_at) or the
-- buyer ceasing to be active — /go checks on every use — stops it.
--
-- The token is stored twice: token_hash (sha256) is what a tap is looked up
-- by; token_encrypted (AES-GCM, the same master key as
-- buyers.encrypted_password) lets staff copy the same link again later, so a
-- message already sent never goes stale because someone re-shared.
--
-- Service role only: RLS on, no policies (like auth_audit_log's writes).
--
-- REVERSAL: drop table buyer_login_links; (links stop working, nothing else
--   references the table).

create table if not exists public.buyer_login_links (
  id              uuid primary key default gen_random_uuid(),
  buyer_id        uuid not null references public.buyers(id) on delete cascade,
  token_hash      text not null unique,
  token_encrypted text not null,
  created_by      uuid references public.staff_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  use_count       integer not null default 0
);

-- At most one live link per buyer; a concurrent second mint loses on this
-- index and re-reads the winner.
create unique index if not exists buyer_login_links_live_idx
  on public.buyer_login_links (buyer_id) where revoked_at is null;

alter table public.buyer_login_links enable row level security;

-- "New link" in admin gets its own audit label instead of reading as
-- "Password regenerated".
alter type public.audit_event_type add value if not exists 'login_link_reset';
