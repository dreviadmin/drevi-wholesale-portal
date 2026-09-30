-- 0072 — a deleted or edited goods receipt takes its stock back out.
--
-- Log delivery posts one 'receipt' movement per line (ref_type
-- 'goods_receipt_line', ref_id = the line). Deleting the receipt, or replacing
-- its lines in the editor, used to leave those movements standing — so a
-- delivery logged by mistake left stock for garments that never arrived, on a
-- SKU that (since e5c347c) is billable at the counter.
--
-- The reversal is its own reason rather than a 'correction', for the same
-- reason 0046 gave returns theirs: the drift report and anyone reading a SKU's
-- history should see "receipt reversed", not a generic fix. It references the
-- SAME line as the movement it undoes, so a line's live contribution is the
-- sum over its ref_id — and a retry after a half-finished delete reverses
-- nothing twice.
--
-- REVERSAL: re-add the 0046 list. Refused while any 'receipt_reversed' row
--   exists; relabel those as 'correction' first.

alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check
  check (reason in ('reset', 'receipt', 'order', 'manual', 'correction', 'shopify_sync', 'return', 'receipt_reversed'));
