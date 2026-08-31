-- 0042 — stock_moved backfill (review fix, 18 Aug).
--
-- postOrderMovements now returns stock on cancel ONLY for lines flagged
-- stock_moved (the flag both line-confirm and whole-order confirm set from
-- 0041 on). Orders confirmed BEFORE this deploy moved their stock without the
-- flag — cancelling one would return nothing. Stamp the flag onto every
-- non-custom, qty>0 line of orders sitting in a stock-out state, which is
-- exactly what the old semantics meant. Idempotent: re-stamping true is a
-- no-op, and orders already carrying flags keep them.

-- Replay guard: this migration re-runs on every db:migrate. A line the NEW
-- code has touched carries line_state or stock_moved explicitly — re-stamping
-- it would undo a post-deploy un-confirm (stock returned, flag cleared) and
-- make a later cancel over-return. Only stamp true LEGACY lines: no
-- line_state key AND no stock_moved key at all.
update orders
   set items = (
     select jsonb_agg(
       case
         when coalesce((it->>'custom')::boolean, false) is not true
          and coalesce((it->>'qty')::numeric, 0) > 0
          and not (it ? 'line_state')
          and not (it ? 'stock_moved')
         then it || '{"stock_moved": true}'::jsonb
         else it
       end
       order by ord
     )
     from jsonb_array_elements(orders.items) with ordinality as t(it, ord)
   )
 where status in ('confirmed', 'packed', 'out_for_delivery')
   and items is not null
   and jsonb_array_length(items) > 0
   and exists (
     select 1 from jsonb_array_elements(orders.items) it2
      where coalesce((it2->>'custom')::boolean, false) is not true
        and coalesce((it2->>'qty')::numeric, 0) > 0
        and not (it2 ? 'line_state')
        and not (it2 ? 'stock_moved')
   );
