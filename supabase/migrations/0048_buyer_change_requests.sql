-- 0048 — buyer-requested changes to staff-approved identity fields, and the
-- credentialed-email uniqueness the buyer write path depends on (Ansh, 13 Sep).
--
-- Deliberately SEPARATE from 0047. 0047 is an integrity fix for already-issued
-- documents; this is new functionality plus a data-hygiene constraint. Keeping
-- them apart means a duplicate-email surprise here cannot roll back the invoice
-- snapshot there.
--
-- Pre-flight run before writing this (13 Sep): dev 2 credentialed buyers /
-- 0 duplicate emails; prod 0 / 0. Re-check before applying to prod.
--
-- Reversal:
--   drop function if exists public.decide_buyer_change(uuid, text, uuid, text);
--   drop table if exists buyer_change_requests;
--   drop index if exists public.buyers_email_credentialed_unique;
--
-- Idempotent: safe to re-run.

-- ════════════════════════════════════════════════════════════════════════════
-- A. CHANGE REQUESTS
-- ════════════════════════════════════════════════════════════════════════════
-- business_name and gstin print on every GST tax invoice, so a buyer may ASK
-- for them but not set them. Each request carries the value it was written
-- against (before_value): an approval that would land on a row someone else has
-- since edited must fail loudly rather than overwrite silently — the same
-- compare-and-swap posture as applyStatus in admin/orders/actions.ts.

create table if not exists buyer_change_requests (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references buyers(id) on delete cascade,

  -- Only the two staff-approved identity fields. Widening this list is a
  -- deliberate migration, not a code change.
  field text not null check (field in ('business_name', 'gstin')),

  -- What the column held when the buyer asked. NULL is a legitimate
  -- before-value (a buyer with no GSTIN yet), which is why the approval
  -- compares with IS DISTINCT FROM and never with <>.
  before_value    text,
  requested_value text not null check (btrim(requested_value) <> '' and length(requested_value) <= 160),
  buyer_note      text check (buyer_note is null or length(buyer_note) <= 300),

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),

  requested_at  timestamptz not null default now(),
  decided_by    uuid references staff_users(id),
  decided_at    timestamptz,
  decision_note text,

  -- Idempotency for a flaky-wifi retry of the same submit (same pattern as
  -- buyers.client_ref and credit_notes.client_ref).
  client_ref uuid,

  constraint bcr_decision_shape check (
    (status =  'pending' and decided_at is null) or
    (status <> 'pending' and decided_at is not null)
  ),
  -- A rejection without a reason is a dead end for the buyer.
  constraint bcr_reject_has_reason check (
    status <> 'rejected' or btrim(coalesce(decision_note, '')) <> ''
  )
);

-- One OPEN request per field per buyer: business_name and gstin may be in
-- flight together (a new GST registration under a renamed firm is a real
-- thing), but never two competing names for the same field. Decided rows are
-- unconstrained, so the full history stays.
create unique index if not exists bcr_one_open_idx
  on buyer_change_requests (buyer_id, field) where status = 'pending';

create index if not exists bcr_pending_idx
  on buyer_change_requests (requested_at) where status = 'pending';

create index if not exists bcr_buyer_idx
  on buyer_change_requests (buyer_id, requested_at desc);

create unique index if not exists bcr_client_ref_idx
  on buyer_change_requests (client_ref) where client_ref is not null;

-- Internal table: RLS on, no policies — service-role only (house rule).
alter table buyer_change_requests enable row level security;

-- ── atomic decision ─────────────────────────────────────────────────────────
-- Two writes must land together (flip the request, write the buyer column) and
-- PostgREST gives no transaction across two calls. Same shape as apply_credit
-- (0046), including the buyer row lock and the trailing revoke.

create or replace function public.decide_buyer_change(
  p_request  uuid,
  p_decision text,     -- 'approved' | 'rejected'
  p_staff    uuid,
  p_note     text
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_req     buyer_change_requests;
  v_current text;
  v_status  text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select * into v_req from buyer_change_requests where id = p_request for update;
  if not found then raise exception 'That request no longer exists'; end if;
  if v_req.status <> 'pending' then
    raise exception 'That request was already %', v_req.status;
  end if;

  if p_decision = 'approved' then
    select status into v_status from buyers where id = v_req.buyer_id for update;

    -- A pending request outlives a suspension, so the buyer's CURRENT standing
    -- is checked here and not only at request time. Approving an identity
    -- change for a suspended account would quietly edit a party that is no
    -- longer trading.
    if v_status is distinct from 'active' then
      raise exception 'That buyer is % — reactivate them before approving identity changes', coalesce(v_status, 'missing');
    end if;

    select case v_req.field
             when 'business_name' then business_name
             when 'gstin'         then gstin
           end
      into v_current
      from buyers where id = v_req.buyer_id;

    -- IS DISTINCT FROM, not <>: a NULL before-value is legitimate.
    if v_current is distinct from v_req.before_value then
      raise exception 'The current value changed after this was requested — review it again';
    end if;

    if v_req.field = 'business_name' then
      update buyers set business_name = v_req.requested_value where id = v_req.buyer_id;
    else
      update buyers set gstin = v_req.requested_value where id = v_req.buyer_id;
    end if;
  end if;

  update buyer_change_requests
     set status = p_decision,
         decided_by = p_staff,
         decided_at = now(),
         decision_note = p_note
   where id = p_request;

  return v_current;   -- the value replaced, for the audit note
end;
$$;

revoke all on function public.decide_buyer_change(uuid, text, uuid, text)
  from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- B. CREDENTIALED-EMAIL UNIQUENESS
-- ════════════════════════════════════════════════════════════════════════════
-- 0007_relax_email_unique.sql dropped buyers_email_key on purpose (field staff
-- reuse a placeholder email at capture) and left uniqueness enforced in
-- application code ONLY, at credential activation — a check-then-write that two
-- concurrent activations can race past. Every buyer-side resolver then does
-- `.eq("email", …).not("encrypted_password","is",null).limit(1)` with NO
-- .order(), so it is deterministic only while that invariant holds. The buyer
-- WRITE path is the first place where losing it means writing to the wrong
-- business, so make it a real constraint.
--
-- Partial: uncredentialed rows may still share a placeholder email, which is
-- the behaviour 0007 deliberately preserved.
create unique index if not exists buyers_email_credentialed_unique
  on public.buyers (lower(email)) where encrypted_password is not null;
