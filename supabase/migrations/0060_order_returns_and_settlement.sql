-- 0060 — returns against an ORDER, and the splittable settlement of a return
-- (Ansh, 21 Sep, two messages):
--   (a) an order shall be editable at any stage, and after delivery there
--       shall be an option to raise a return for some of its items, which
--       updates the SKU count;
--   (b) the return's value may be split, at once, across
--         1) credit note   — kept on account
--         2) refunded      — money out of the till
--         3) adjusted      — set against a balance still due.
--
-- ======================================================================
-- PART 1 — a return may anchor to the ORDER.
-- ======================================================================
-- 0046 required every return to name an order_bill, because order_bills.items
-- is immutable while orders.items is re-packed by Modify Order. That reasoning
-- is sound about the SNAPSHOT and wrong about the DOCUMENT: 42 of 43 orders
-- have no bill, and their invoice is the order's own PDF, which already prints
-- as "WHOLESALE - INVOICE" with the supplier GSTIN and a GST breakdown for
-- every source except portal_self_service (order-pdf.tsx, isInvoice; all 43
-- prod orders are in_store or exhibition). Raising a bill just to reach the
-- return would issue a SECOND tax invoice for a supply already invoiced,
-- dated today rather than on the supply date. Owner confirmed 21 Sep that the
-- order's own PDF is what GST is filed against.
--
-- The immutability the constraint was protecting is provided instead by the
-- note itself: credit_notes.items already freezes sku/title/hsn/qty/unit_price
-- per returned line, and orders.items[i].returned_qty — written under the
-- lines_rev CAS — is the arbiter of who may return a piece. On top of that
-- sits an edit policy (updateOrderItems) that freezes a returned line and the
-- order's money terms once a note exists.
--
-- A return still MUST name a document it reverses. Bill-anchored returns keep
-- working unchanged for lines that carry billed_in.
alter table credit_notes drop constraint if exists cn_return_has_bill;
alter table credit_notes add constraint cn_return_has_source
  check (kind <> 'return' or order_bill_id is not null or order_id is not null);

-- ======================================================================
-- PART 2 — the settlement.
-- ======================================================================
--  * source_note_id — WHICH note a consumption row came from. credit_ledger is
--    a per-PARTY pool: an 'applied' row points at the ORDER it was spent on,
--    never at the note it came from, so "how much of THIS note is left" is
--    today a FIFO inference (allocateConsumption), not a record. Fine for a
--    wallet statement, useless for a per-return settlement — with two open
--    notes a later note's spend is attributed to an earlier one, and voiding
--    one silently re-points the other's allocation. It is also what makes the
--    per-note cap enforceable and lets void ask a one-line question.
--
--  * method — cash / bank transfer / UPI / cheque: the one field anyone will
--    ever total or filter on ("how much cash went out this month"). A grep
--    over free text is not a report. The reference (UTR, cheque no) goes in
--    the existing `note`, mirroring recordPayment, which keeps a singular
--    orders.payment_method beside an appended free-text line — money in and
--    money out then read the same way.
--
-- A refund_details side table was rejected for the reason 0046's own header
-- gives: a companion insert a timeout can drop leaves an unexplained -6,495
-- with no method and no reference, and nothing makes the pair atomic.
--
-- credit_notes and credit_ledger are BOTH EMPTY in production, so every change
-- here is additive with no backfill and no issued document to stay compatible
-- with. Re-confirm that immediately before applying to prod.
alter table credit_ledger add column if not exists source_note_id uuid
  references credit_notes(id) on delete restrict;
alter table credit_ledger add column if not exists method text;

create index if not exists cl_source_note_idx on credit_ledger (source_note_id)
  where source_note_id is not null;

-- ======================================================================
-- PART 3 — a bill can be cancelled.
-- ======================================================================
-- orders/actions.ts already tells staff "Cancel that bill first" when a billed
-- line blocks an edit — naming an action that exists nowhere in the codebase.
-- A tax invoice is not deleted, it is cancelled and kept, exactly as a credit
-- note is voided rather than edited. Cancelling frees the order's lines
-- (billed_in cleared by the action) so they return to the order path.
alter table order_bills add column if not exists cancelled_at timestamptz;
alter table order_bills add column if not exists cancelled_by text;
alter table order_bills add column if not exists cancel_reason text;

-- ----------------------------------------------------------------------
-- apply_credit — dropped and recreated to gain p_source_note.
--
-- CREATE OR REPLACE cannot add a parameter; a 7-arg overload beside the 6-arg
-- original would make a 6-named-arg PostgREST call ambiguous. The DEFAULT
-- keeps every existing call site working, and `notify pgrst` at the foot of
-- this file reloads the schema cache that would otherwise report the function
-- as missing.
--
-- Three additions, all guards that existed only in JS and were therefore races
-- rather than rules:
--   · p_source_note + the per-note cap. The wallet check cannot see it: the
--     ledger is a per-party pool, so a second open note would happily fund an
--     overshoot on the first.
--   · the ORDER-DUE cap, under a lock on the order row. applyCreditToOrder
--     refuses when due <= 0 and caps at due, but the RPC had no order guard of
--     any kind, so a recordPayment landing between that caller's read and this
--     call overshoots the order total — invisibly, because every balance-due
--     surface clamps with max(0, ...).
--   · a refusal on a cancelled order.
-- ----------------------------------------------------------------------
drop function if exists public.apply_credit(uuid, uuid, numeric, uuid, text, text);

create or replace function public.apply_credit(
  p_buyer uuid,
  p_order uuid,
  p_amount numeric,
  p_client_ref uuid,
  p_note text,
  p_created_by text,
  p_source_note uuid default null
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
  v_note credit_notes;
  v_note_used numeric;
  v_order orders;
  v_due numeric;
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

  -- Serialise per party: the balance is a SUM, so no CHECK can hold it.
  perform 1 from buyers where id = p_buyer for update;

  if p_source_note is not null then
    select * into v_note from credit_notes where id = p_source_note;
    if not found then raise exception 'That credit note no longer exists'; end if;
    if v_note.status <> 'issued' then raise exception 'A void credit note cannot be settled'; end if;
    if v_note.buyer_id is distinct from p_buyer then
      raise exception 'That credit note belongs to another party';
    end if;
    -- 'unapplied' rows carry delta > 0, so -delta < 0 and a reversal correctly
    -- frees the room back up.
    select coalesce(sum(-delta), 0) into v_note_used
      from credit_ledger where source_note_id = p_source_note;
    if round(v_note_used + p_amount, 2) > round(v_note.total, 2) then
      raise exception 'Only % of that credit note is still unsettled',
        round(v_note.total - v_note_used, 2);
    end if;
  end if;

  if p_order is not null then
    select * into v_order from orders where id = p_order for update;
    if not found then raise exception 'That order no longer exists'; end if;
    if v_order.status = 'cancelled' then
      raise exception 'That order is cancelled - nothing is owed on it';
    end if;
    v_due := round(greatest(0, coalesce(v_order.total_amount, 0)
                             - coalesce(v_order.advance_amount, 0)
                             - coalesce(v_order.credit_applied, 0)), 2);
    if v_due <= 0 then
      raise exception '% is settled in full - there is nothing to set credit against', v_order.order_number;
    end if;
    if p_amount > v_due then
      raise exception '% only has % still outstanding', v_order.order_number, v_due;
    end if;
  end if;

  select coalesce(sum(total), 0) into v_granted
    from credit_notes where buyer_id = p_buyer and status = 'issued';
  select coalesce(sum(delta), 0) into v_used
    from credit_ledger where buyer_id = p_buyer;
  v_balance := round(v_granted + v_used, 2);

  if p_amount > v_balance then
    raise exception 'Only % of credit is available', v_balance;
  end if;

  insert into credit_ledger
    (buyer_id, delta, reason, ref_type, ref_id, source_note_id, note, client_ref, created_by)
  values
    (p_buyer, -round(p_amount, 2), 'applied', 'order', p_order, p_source_note,
     p_note, p_client_ref, p_created_by);

  if p_order is not null then
    update orders set credit_applied = round(coalesce(credit_applied, 0) + p_amount, 2)
     where id = p_order;
  end if;

  return round(v_balance - p_amount, 2);
end;
$$;

-- ----------------------------------------------------------------------
-- settle_return — the two consumption legs of ONE return, in ONE transaction.
--
-- One function rather than two calls, because a refund that lands while the
-- adjustment fails is a half-settled return no surface can explain. The
-- "credit note" leg is absent by construction: it is whatever neither of the
-- other two consumed, which is also exactly what allocateConsumption already
-- reports as that note's `remaining`.
--
-- The adjustment leg calls apply_credit rather than re-inserting, so there
-- stays exactly ONE writer of orders.credit_applied. The buyers lock is
-- re-entrant inside the transaction. The refund row is written FIRST so
-- apply_credit's wallet check sees the money already gone.
--
-- p_order may be ANY open order of the same buyer, not only the one returned
-- (owner, 21 Sep) — apply_credit re-reads and locks whichever order it names.
--
-- cl_client_ref_idx is UNIQUE, so only one of the two rows may carry the key:
-- it goes on the refund row when there is one. Both rows land in the same
-- transaction, so the single probe at the top is a complete replay guard.
-- ----------------------------------------------------------------------
create or replace function public.settle_return(
  p_note uuid,
  p_refund numeric,
  p_adjust numeric,
  p_order uuid,
  p_method text,
  p_reference text,
  p_client_ref uuid,
  p_created_by text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note credit_notes;
  v_refund numeric := round(coalesce(p_refund, 0), 2);
  v_adjust numeric := round(coalesce(p_adjust, 0), 2);
  v_note_used numeric;
  v_unsettled numeric;
  v_granted numeric;
  v_used numeric;
  v_balance numeric;
begin
  if v_refund < 0 or v_adjust < 0 then
    raise exception 'A settlement leg cannot be negative';
  end if;
  -- The whole note stays on account. That is leg 1, and it writes nothing.
  if v_refund = 0 and v_adjust = 0 then
    return null;
  end if;
  if v_refund > 0 and coalesce(btrim(p_method), '') = '' then
    raise exception 'Say how the money went out - cash, bank transfer, UPI or cheque';
  end if;

  if p_client_ref is not null
     and exists (select 1 from credit_ledger where client_ref = p_client_ref) then
    return null;
  end if;

  select * into v_note from credit_notes where id = p_note;
  if not found then raise exception 'That credit note no longer exists'; end if;
  if v_note.status <> 'issued' then raise exception 'A void credit note cannot be settled'; end if;
  if v_note.buyer_id is null then raise exception 'That credit note has no party to settle with'; end if;

  perform 1 from buyers where id = v_note.buyer_id for update;

  -- THE PER-NOTE CAP: the legs of ONE return may never together exceed that
  -- return's value.
  select coalesce(sum(-delta), 0) into v_note_used
    from credit_ledger where source_note_id = p_note;
  v_unsettled := round(v_note.total - v_note_used, 2);
  if v_refund + v_adjust > v_unsettled then
    raise exception 'Only % of this credit note is still unsettled', v_unsettled;
  end if;

  select coalesce(sum(total), 0) into v_granted
    from credit_notes where buyer_id = v_note.buyer_id and status = 'issued';
  select coalesce(sum(delta), 0) into v_used
    from credit_ledger where buyer_id = v_note.buyer_id;
  v_balance := round(v_granted + v_used, 2);
  if v_refund + v_adjust > v_balance then
    raise exception 'Only % of credit is available', v_balance;
  end if;

  -- Leg 2 - cash out of the till. orders.credit_applied is deliberately NOT
  -- touched: money paid back reduces no order's balance.
  if v_refund > 0 then
    insert into credit_ledger
      (buyer_id, delta, reason, ref_type, ref_id, source_note_id, method, note, client_ref, created_by)
    values
      (v_note.buyer_id, -v_refund, 'refund', 'credit_note', p_note, p_note,
       btrim(p_method),
       'Refunded against ' || v_note.note_number ||
         case when coalesce(btrim(p_reference), '') = '' then '' else ' - ' || btrim(p_reference) end,
       p_client_ref, p_created_by);
  end if;

  -- Leg 3 - set against a balance still due. One writer of credit_applied.
  if v_adjust > 0 then
    if p_order is null then
      raise exception 'Say which order the credit is being set against';
    end if;
    perform public.apply_credit(
      v_note.buyer_id, p_order, v_adjust,
      case when v_refund > 0 then null else p_client_ref end,
      'Applied from ' || v_note.note_number,
      p_created_by, p_note);
  end if;

  return round(v_balance - v_refund - v_adjust, 2);
end;
$$;

-- ----------------------------------------------------------------------
-- unapply_credit — two changes.
--
-- 1) A REFUND IS NOW REVERSIBLE. 0046 raised on any reason but 'applied',
--    which would make a return settled even partly in cash permanently
--    unvoidable — the only exit a manual database write, on the one document
--    type the codebase insists is voided rather than edited. No new shape is
--    needed: the reversal is 'unapplied' with delta > 0 (cl_sign permits it),
--    keyed by ref_id so cl_unapply_once_idx still makes a double tap a no-op,
--    and the credit_applied write below is already gated on ref_type='order'
--    so a refund reversal correctly leaves every order alone. source_note_id
--    and method are carried forward, or the per-note cap stops netting and a
--    reversed refund is never re-spendable.
--
-- 2) IT REFUSES TO RE-OPEN A PAID ORDER. recordPayment landed on 21 Sep. Undo
--    an application on an order since settled in cash and the same rupees
--    become spendable wallet credit AND a re-opened receivable, invisible
--    because every balance surface clamps with max(0, ...). If the money is
--    genuinely owed back, a refund is the instrument, not a reversal.
-- ----------------------------------------------------------------------
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
  v_order orders;
begin
  select * into v_entry from credit_ledger where id = p_entry;
  if not found then raise exception 'That credit entry no longer exists'; end if;
  if v_entry.reason not in ('applied', 'refund') then
    raise exception 'Only an applied credit or a recorded refund can be reversed';
  end if;

  perform 1 from buyers where id = v_entry.buyer_id for update;

  if v_entry.reason = 'applied' and v_entry.ref_type = 'order' and v_entry.ref_id is not null then
    select * into v_order from orders where id = v_entry.ref_id for update;
    if found and coalesce(v_order.advance_amount, 0) >= coalesce(v_order.total_amount, 0) then
      raise exception '% has since been paid in full - reversing this would re-open a balance that is not owed. Refund the credit note instead.',
        v_order.order_number;
    end if;
  end if;

  insert into credit_ledger
    (buyer_id, delta, reason, ref_type, ref_id, source_note_id, method, note, created_by)
  values
    (v_entry.buyer_id, -v_entry.delta, 'unapplied', 'credit_ledger', v_entry.id,
     v_entry.source_note_id, v_entry.method,
     case when v_entry.reason = 'refund'
          then 'Reversed a recorded refund - the money is back on account'
          else 'Reversed credit applied to an order' end,
     p_created_by);

  if v_entry.ref_type = 'order' and v_entry.ref_id is not null then
    update orders set credit_applied = greatest(0, round(coalesce(credit_applied, 0) + v_entry.delta, 2))
     where id = v_entry.ref_id;
  end if;

  return -v_entry.delta;
end;
$$;

-- House rule: security-definer RPCs are service-role only.
revoke all on function public.apply_credit(uuid, uuid, numeric, uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.settle_return(uuid, numeric, numeric, uuid, text, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.unapply_credit(uuid, text)
  from public, anon, authenticated;

-- apply_credit's signature changed and PostgREST caches it; a stale cache
-- reports the function as missing and the failure reads like a code bug.
notify pgrst, 'reload schema';
