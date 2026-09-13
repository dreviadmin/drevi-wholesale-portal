-- 0047 — freeze the buyer's identity onto every issued document (Ansh, 13 Sep 2026).
--
-- WHY THIS EXISTS. The party block on every wholesale document is looked up
-- LIVE at render time:
--
--   src/app/api/orders/[id]/pdf/route.ts       .from("buyers").select("business_name, owner_name, phone, city")
--   src/lib/order-finalize.ts                  same — and it OVERWRITES the stored file at orders.pdf_url
--   src/app/admin/orders/actions.ts            same — for a bill whose LINES are already snapshotted (0041)
--   src/app/api/credit-notes/[id]/pdf/route.ts same — for a note whose items and source bill are snapshotted (0046)
--
-- So one edit to a buyers row silently rewrites every invoice, bill and credit
-- note that party has ever been issued. 0041_order_bills.sql exists so that "a
-- printed bill never changes retroactively when the order is edited"; the party
-- block is the one thing it forgot to freeze. That is already wrong for staff
-- edits today, and it is indefensible the moment a buyer can edit their own
-- details — which is what 0049 enables. This lands and is proven FIRST.
--
-- SCOPE, stated honestly: this freezes WHO a document is addressed to. It does
-- not freeze what the document charges — orders.items still drift for an
-- order-level PDF. Bills and credit notes already snapshot their own lines.
--
-- THE RULE for split bills and mid-order changes: the recipient identity on a
-- tax document is the identity at THAT DOCUMENT's own issue date. So bill B2
-- legitimately differs from B1 if the party changed between them. Each document
-- is a statement about a moment, not about the order.
--
-- retail_bills already snapshots its party on the row (customer_name /
-- customer_phone, 0043) and is deliberately untouched.
--
-- Reversal:
--   alter table public.orders       drop column if exists buyer_business_name, ... ;
--   alter table public.order_bills  drop column if exists ... ;
--   alter table public.credit_notes drop column if exists ... ;
--   drop index if exists orders_no_buyer_snapshot_idx, ob_no_buyer_snapshot_idx, cn_no_buyer_snapshot_idx;
--   (enum values cannot be dropped; they are inert once unused.)
--
-- Idempotent: safe to re-run.

-- ════════════════════════════════════════════════════════════════════════════
-- 0. AUDIT VOCABULARY
-- ════════════════════════════════════════════════════════════════════════════
-- audit_event_type is a Postgres ENUM (0001_init.sql), not a text check, so an
-- insert with an unlisted value fails at the database. Added here and USED
-- NOWHERE in this file: Postgres permits `add value` in a transaction only
-- while the new label is not used in that same transaction. Precedent for
-- mixing table DDL with enum growth: 0014_vendors_receipts.sql, 0016_studio.sql.

alter type audit_event_type add value if not exists 'buyer_profile_updated';
alter type audit_event_type add value if not exists 'buyer_change_requested';
alter type audit_event_type add value if not exists 'buyer_change_approved';
alter type audit_event_type add value if not exists 'buyer_change_rejected';
alter type audit_event_type add value if not exists 'document_party_recaptured';

-- ════════════════════════════════════════════════════════════════════════════
-- A. DOCUMENT BUYER SNAPSHOT
-- ════════════════════════════════════════════════════════════════════════════
-- The same six identity fields plus two provenance fields on all three document
-- tables. buyer_snapshot_at is the ONLY flag the render path branches on: null
-- means "no snapshot on this row, fall back to the live buyers read", which
-- exists purely to cover rows inserted by a pre-0047 instance during the deploy
-- window (a Vercel deploy is not atomic with a migration).
--
-- buyer_snapshot_source values:
--   'issue'           captured in the same statement that created the row, on its own date.
--   'issue_backdated' captured at issue, but the document carries an EARLIER date than the
--                     capture (generateOrderBill accepts a past bill_date). Today's identity
--                     is being stamped on a document dated to the past — flagged, not hidden.
--   'queued'          arrived through the offline exhibition drainer, so the capture time is
--                     queue-drain time, not sale time.
--   'backfill'        captured by THIS migration from the then-current buyers row: what the
--                     document was already printing on 13 Sep 2026, NOT a verified record of
--                     what it printed on its own issue date.
--
-- gstin and address are frozen even though no PDF prints them yet (order-pdf
-- draws only business_name, owner_name, phone, city). A snapshot can only be
-- taken at issue time: add the column in 2027 and every document issued before
-- then carries 2027's GSTIN, or nothing. Two nullable text columns is the whole
-- cost of never having that problem.

alter table public.orders
  add column if not exists buyer_business_name   text,
  add column if not exists buyer_owner_name      text,
  add column if not exists buyer_phone           text,
  add column if not exists buyer_city            text,
  add column if not exists buyer_gstin           text,
  add column if not exists buyer_address         text,
  add column if not exists buyer_snapshot_at     timestamptz,
  add column if not exists buyer_snapshot_source text;

alter table public.order_bills
  add column if not exists buyer_business_name   text,
  add column if not exists buyer_owner_name      text,
  add column if not exists buyer_phone           text,
  add column if not exists buyer_city            text,
  add column if not exists buyer_gstin           text,
  add column if not exists buyer_address         text,
  add column if not exists buyer_snapshot_at     timestamptz,
  add column if not exists buyer_snapshot_source text;

alter table public.credit_notes
  add column if not exists buyer_business_name   text,
  add column if not exists buyer_owner_name      text,
  add column if not exists buyer_phone           text,
  add column if not exists buyer_city            text,
  add column if not exists buyer_gstin           text,
  add column if not exists buyer_address         text,
  add column if not exists buyer_snapshot_at     timestamptz,
  add column if not exists buyer_snapshot_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_snapshot_source_shape') then
    alter table public.orders add constraint orders_snapshot_source_shape
      check (buyer_snapshot_source is null or buyer_snapshot_source in ('issue','issue_backdated','queued','backfill'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ob_snapshot_source_shape') then
    alter table public.order_bills add constraint ob_snapshot_source_shape
      check (buyer_snapshot_source is null or buyer_snapshot_source in ('issue','issue_backdated','queued','backfill'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cn_snapshot_source_shape') then
    alter table public.credit_notes add constraint cn_snapshot_source_shape
      check (buyer_snapshot_source is null or buyer_snapshot_source in ('issue','issue_backdated','queued','backfill'));
  end if;
end $$;

-- ── backfill ────────────────────────────────────────────────────────────────
-- These UPDATEs do NOT change what a legacy document prints today: the on-demand
-- order route and the credit-note route already render from exactly these
-- values, which is the bug. They freeze what is currently printed so the NEXT
-- edit cannot move it.
--
-- Honest caveat, deliberately not glossed: for order_bills, and for orders with
-- a non-null pdf_url, the file a customer already HOLDS was rendered earlier and
-- may show something different. The backfill cannot recover that; it records
-- today's values and labels them 'backfill' so nobody mistakes a reconstructed
-- city for a captured one.
--
-- buyer_snapshot_at is now(), deliberately NOT the row's own created_at.
-- Backdating would be the actual lie — an unrecoverable claim that these values
-- were contemporaneous with issue.

update public.orders o
   set buyer_business_name = b.business_name, buyer_owner_name = b.owner_name,
       buyer_phone = b.phone, buyer_city = b.city, buyer_gstin = b.gstin,
       buyer_address = b.address, buyer_snapshot_at = now(), buyer_snapshot_source = 'backfill'
  from public.buyers b
 where b.id = o.buyer_id and o.buyer_snapshot_at is null;

update public.order_bills ob
   set buyer_business_name = b.business_name, buyer_owner_name = b.owner_name,
       buyer_phone = b.phone, buyer_city = b.city, buyer_gstin = b.gstin,
       buyer_address = b.address, buyer_snapshot_at = now(), buyer_snapshot_source = 'backfill'
  from public.orders o
  join public.buyers b on b.id = o.buyer_id
 where o.id = ob.order_id and ob.buyer_snapshot_at is null;

update public.credit_notes cn
   set buyer_business_name = b.business_name, buyer_owner_name = b.owner_name,
       buyer_phone = b.phone, buyer_city = b.city, buyer_gstin = b.gstin,
       buyer_address = b.address, buyer_snapshot_at = now(), buyer_snapshot_source = 'backfill'
  from public.buyers b
 where b.id = cn.buyer_id and cn.buyer_snapshot_at is null;

-- ── monitoring ──────────────────────────────────────────────────────────────
-- After the backfill these predicates match nothing, so the indexes are ~empty.
-- They exist so "did a row slip through the deploy window?" is a millisecond
-- check rather than a seq scan.
create index if not exists orders_no_buyer_snapshot_idx
  on public.orders (submitted_at desc) where buyer_snapshot_at is null;
create index if not exists ob_no_buyer_snapshot_idx
  on public.order_bills (created_at desc) where buyer_snapshot_at is null;
create index if not exists cn_no_buyer_snapshot_idx
  on public.credit_notes (created_at desc) where buyer_snapshot_at is null;

-- RLS note: order_bills and credit_notes are service-role-only (RLS on, no
-- policies — 0041, 0046), so nothing changes there. orders has a buyer select
-- policy (0001_init.sql, buyer_id = current_buyer_id()), so a buyer can now read
-- buyer_gstin / buyer_address off their OWN order rows. That is their own data
-- echoed back to them.
