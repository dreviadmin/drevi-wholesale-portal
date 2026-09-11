-- Credit notes, returns and per-party wallets (Ansh, 11 Sep).
--
-- Shape decisions, each one the answer to a specific way the first draft was wrong:
--
--  * A credit note IS the grant. The wallet balance is
--      Σ(credit_notes.total where status='issued') − Σ(|credit_ledger.delta|)
--    so a note can never exist without the credit behind it (an earlier design
--    wrote a separate "+" ledger row last, which a timeout could drop — leaving
--    a note that had been WhatsApped to the customer with an empty wallet).
--    credit_ledger therefore records CONSUMPTION only: negative deltas when
--    credit is spent, positive ones only to reverse a specific consumption.
--
--  * Returns anchor to the BILL snapshot (order_bills.items is immutable),
--    never to a position in orders.items — Modify Order re-packs that array, so
--    an index would silently come to mean a different garment.
--
--  * The credit for a returned line is its share of what was actually CHARGED:
--    the bill's discount is allocated pro-rata, then the bill's own tax mode is
--    applied. Crediting the raw unit price refunds money the buyer never paid.
--
--  * orders.credit_applied is a denormalised cache of the consumption rows
--    (same relationship current_qty has with stock_movements) so every existing
--    "balance due" surface can subtract it without a join.

-- Returned goods deserve their own reason in the ledger rather than hiding
-- inside 'correction'. The CHECK is an inline (auto-named) constraint, so it
-- must be dropped before it can be widened.
alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check
  check (reason in ('reset', 'receipt', 'order', 'manual', 'correction', 'shopify_sync', 'return'));

create table if not exists credit_notes (
  id uuid primary key default gen_random_uuid(),
  note_number text not null unique,              -- CN-YYYYMMDD-NNN via next_order_number
  kind text not null check (kind in ('return', 'manual')),

  buyer_id uuid references buyers(id) on delete restrict,
  order_id uuid references orders(id) on delete restrict,
  order_bill_id uuid references order_bills(id) on delete restrict,

  -- Denormalised so the PDF can print "against invoice X dated Y" without a
  -- join — an Indian credit note must reference the original invoice.
  source_bill_number text,
  source_bill_date date,

  -- Snapshot of what came back. Each entry:
  --   { sku, title, hsn, qty, unit_price, line_amount, discount_share,
  --     net_amount, bill_line_index, order_line_index, restock, image_url }
  items jsonb not null default '[]'::jsonb,

  source_subtotal numeric(12,2) not null default 0,  -- Σ qty × unit_price returned
  discount_share  numeric(12,2) not null default 0,  -- pro-rata slice of the bill's discount
  subtotal        numeric(12,2) not null default 0,  -- source_subtotal − discount_share
  tax_mode text check (tax_mode in ('none', 'inclusive', 'exclusive')),
  tax_rate numeric,
  tax_amount numeric(12,2) not null default 0,
  total    numeric(12,2) not null default 0,

  reason text not null,
  note_date date not null,
  status text not null default 'issued' check (status in ('issued', 'void')),
  voided_at timestamptz, voided_by text, void_reason text,

  client_ref uuid,
  pdf_url text,
  created_by text not null,
  created_at timestamptz not null default now(),

  -- A return must come from a bill; a manual note must not, and must credit a
  -- party (crediting nobody is the one thing a manual note cannot mean).
  constraint cn_return_has_bill   check (kind <> 'return' or order_bill_id is not null),
  constraint cn_return_has_items  check (kind <> 'return' or jsonb_array_length(items) > 0),
  constraint cn_manual_has_no_bill check (kind <> 'manual' or order_bill_id is null),
  constraint cn_manual_has_party  check (kind <> 'manual' or buyer_id is not null),
  constraint cn_bill_needs_order  check (order_bill_id is null or order_id is not null),
  -- orders.buyer_id is NOT NULL, so a wholesale note always has a party.
  constraint cn_order_has_party   check (order_id is null or buyer_id is not null),
  constraint cn_total_non_negative check (total >= 0),
  constraint cn_void_shape check (
    (status = 'void' and voided_at is not null) or (status = 'issued' and voided_at is null)
  )
);

create index if not exists cn_buyer_idx       on credit_notes (buyer_id, created_at desc);
create index if not exists cn_order_idx       on credit_notes (order_id);
-- The returnable-quantity cap queries by bill; without this it is a seq scan.
create index if not exists cn_order_bill_idx  on credit_notes (order_bill_id);
create index if not exists cn_created_idx     on credit_notes (created_at desc);
create unique index if not exists cn_client_ref_idx on credit_notes (client_ref) where client_ref is not null;

-- Consumption only (see the header): negative when credit is spent, positive
-- only when a specific consumption is reversed.
create table if not exists credit_ledger (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references buyers(id) on delete restrict,
  delta numeric(12,2) not null,
  reason text not null check (reason in ('applied', 'unapplied', 'refund')),
  ref_type text, ref_id uuid,
  note text,
  client_ref uuid,
  effective_date date not null default (now() at time zone 'Asia/Kolkata')::date,
  created_by text not null,
  created_at timestamptz not null default now(),

  constraint cl_sign check (
    (reason in ('applied', 'refund') and delta < 0) or (reason = 'unapplied' and delta > 0)
  )
);

create index if not exists cl_buyer_idx on credit_ledger (buyer_id, effective_date, created_at);
create index if not exists cl_ref_idx   on credit_ledger (ref_type, ref_id);
create unique index if not exists cl_client_ref_idx on credit_ledger (client_ref) where client_ref is not null;
-- An application may be reversed exactly once.
create unique index if not exists cl_unapply_once_idx on credit_ledger (ref_id)
  where reason = 'unapplied' and ref_type = 'credit_ledger';

-- Internal tables: RLS on, no policies — service-role only (house rule).
alter table credit_notes  enable row level security;
alter table credit_ledger enable row level security;

-- Read-only cache of the consumption rows, maintained inside apply_credit /
-- unapply_credit so every existing "balance due" surface can subtract credit
-- from a plain orders row.
alter table orders add column if not exists credit_applied numeric(12,2) not null default 0;

-- Spending credit must be serialised per party: the balance is a SUM, so no
-- CHECK can stop two concurrent applications from overdrawing it. Lock the
-- buyer row, recompute inside the transaction, then insert — the same
-- security-definer RPC shape as next_order_number.
create or replace function public.apply_credit(
  p_buyer uuid,
  p_order uuid,
  p_amount numeric,
  p_client_ref uuid,
  p_note text,
  p_created_by text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_granted numeric;
  v_used numeric;
  v_balance numeric;
  v_existing credit_ledger;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Credit amount must be more than zero';
  end if;

  -- Replay of the same click resolves to the row already written.
  if p_client_ref is not null then
    select * into v_existing from credit_ledger where client_ref = p_client_ref;
    if found then
      select coalesce(sum(total), 0) into v_granted
        from credit_notes where buyer_id = p_buyer and status = 'issued';
      select coalesce(sum(delta), 0) into v_used from credit_ledger where buyer_id = p_buyer;
      return round(v_granted + v_used, 2);
    end if;
  end if;

  perform 1 from buyers where id = p_buyer for update;

  select coalesce(sum(total), 0) into v_granted
    from credit_notes where buyer_id = p_buyer and status = 'issued';
  select coalesce(sum(delta), 0) into v_used
    from credit_ledger where buyer_id = p_buyer;
  v_balance := round(v_granted + v_used, 2);

  if p_amount > v_balance then
    raise exception 'Only % of credit is available', v_balance;
  end if;

  insert into credit_ledger (buyer_id, delta, reason, ref_type, ref_id, note, client_ref, created_by)
  values (p_buyer, -round(p_amount, 2), 'applied', 'order', p_order, p_note, p_client_ref, p_created_by);

  if p_order is not null then
    update orders set credit_applied = round(coalesce(credit_applied, 0) + p_amount, 2)
     where id = p_order;
  end if;

  return round(v_balance - p_amount, 2);
end;
$$;

-- Reversing one application. Guarded by cl_unapply_once_idx so a double tap
-- cannot refund the same application twice.
create or replace function public.unapply_credit(
  p_entry uuid,
  p_created_by text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry credit_ledger;
begin
  select * into v_entry from credit_ledger where id = p_entry;
  if not found then raise exception 'That credit application no longer exists'; end if;
  if v_entry.reason <> 'applied' then raise exception 'Only an applied credit can be reversed'; end if;

  perform 1 from buyers where id = v_entry.buyer_id for update;

  insert into credit_ledger (buyer_id, delta, reason, ref_type, ref_id, note, created_by)
  values (v_entry.buyer_id, -v_entry.delta, 'unapplied', 'credit_ledger', v_entry.id,
          'Reversed credit applied to an order', p_created_by);

  if v_entry.ref_type = 'order' and v_entry.ref_id is not null then
    update orders set credit_applied = greatest(0, round(coalesce(credit_applied, 0) + v_entry.delta, 2))
     where id = v_entry.ref_id;
  end if;

  return -v_entry.delta;
end;
$$;

revoke all on function public.apply_credit(uuid, uuid, numeric, uuid, text, text) from public, anon, authenticated;
revoke all on function public.unapply_credit(uuid, text) from public, anon, authenticated;
