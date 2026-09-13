-- 0049 — a fourth provenance value: 'recapture' (13 Sep 2026).
--
-- recaptureDocumentParty is the audited staff path for correcting a genuinely
-- wrong recipient on an already-issued document (0047 froze the party, which
-- removed the old "edit the buyer and re-render" correction). It was stamping
-- buyer_snapshot_source = 'issue', which asserts the value was captured when
-- the document was issued — the exact claim 'issue_backdated' and 'backfill'
-- exist to avoid making falsely.
--
-- It also makes "which documents have been corrected after issue?" a query
-- rather than a trawl through auth_audit_log.
--
-- Idempotent: safe to re-run. Reversal: re-add the constraints without
-- 'recapture' (only possible once no row uses it).

do $$
declare
  t text;
  c text;
begin
  foreach t in array array['orders', 'order_bills', 'credit_notes'] loop
    c := case t
           when 'orders'       then 'orders_snapshot_source_shape'
           when 'order_bills'  then 'ob_snapshot_source_shape'
           else                     'cn_snapshot_source_shape'
         end;
    execute format('alter table public.%I drop constraint if exists %I', t, c);
    execute format(
      'alter table public.%I add constraint %I check (buyer_snapshot_source is null or '
      || 'buyer_snapshot_source in (''issue'', ''issue_backdated'', ''queued'', ''backfill'', ''recapture''))',
      t, c);
  end loop;
end $$;

-- Corrected documents are rare and worth finding instantly.
create index if not exists orders_recaptured_idx
  on public.orders (buyer_snapshot_at desc) where buyer_snapshot_source = 'recapture';
create index if not exists ob_recaptured_idx
  on public.order_bills (buyer_snapshot_at desc) where buyer_snapshot_source = 'recapture';
