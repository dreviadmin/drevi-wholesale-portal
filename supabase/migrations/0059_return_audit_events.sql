-- 0059 — audit vocabulary for returns, credit notes and refunds (Ansh, 21 Sep).
--
-- audit_event_type is an ENUM (0001_init), so writeAuditEvent fails at the
-- database on an unlisted label. Added here and used NOWHERE in this file:
-- Postgres permits `add value` inside a transaction only while the new label
-- is unused in that same transaction. Same pattern as 0014, 0047, 0058.
--
-- Money leaving the business earns its own label rather than hiding inside a
-- generic settlement event.

alter type audit_event_type add value if not exists 'return_credit_note_raised';
alter type audit_event_type add value if not exists 'return_credit_note_voided';
alter type audit_event_type add value if not exists 'credit_settled';
alter type audit_event_type add value if not exists 'order_bill_cancelled';
