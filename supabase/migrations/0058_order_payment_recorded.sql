-- 0058 — audit vocabulary for recording a payment against an order.
--
-- Ansh, 21 Sep: "after an order is fulfilled there shall be an option to
-- record payment. VALLABHAM had payment due which they have paid, but there's
-- no option to mark payment." DX-20260717-017 is 'fulfilled' with ₹33,501.51
-- outstanding, and the only writer of orders.advance_amount was the order
-- editor, which returns null past 'confirmed'.
--
-- audit_event_type is a Postgres ENUM (0001_init.sql), so an insert with an
-- unlisted value fails at the database. Added here and USED NOWHERE in this
-- file: Postgres permits `add value` in a transaction only while the new label
-- is not used in that same transaction. Precedent: 0014, 0015, 0047.
--
-- Money moving is exactly the thing that should leave a trail, which is why
-- this earns a migration where the studio's job-cancel did not.

alter type audit_event_type add value if not exists 'order_payment_recorded';
