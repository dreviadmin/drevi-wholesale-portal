-- 0075 — bring generate_sku, next_order_number, order_counters and
-- sync_ignored_skus in line with the house rule that security-definer RPCs and
-- internal tables are service-role only (as in 0046, 0048, 0060).
-- A second, separately commented section at the end fixes the pipeline_jobs
-- staff-read policy (0017), which matched no one.
--
-- generate_sku (0013) and next_order_number (0008) predate that rule and kept
-- the default EXECUTE grants. Every caller in src/ and scripts/ uses the
-- service-role client (createAdminClient / SUPABASE_SERVICE_ROLE_KEY) —
-- checked by grepping every .rpc( call, last on 11 Nov — so this changes
-- nothing the app does. The explicit grant to service_role below keeps it that
-- way whatever the defaults were.
--
-- order_counters (0008) and sync_ignored_skus (0010) get RLS with no policies,
-- like the other internal tables. Only service-role code touches them
-- (next_order_number as definer, the sync, manage-catalog's rename, the
-- backups); the service role bypasses RLS and the definer function runs as
-- the table owner, so both carry on as before.
--
-- generate_sku also gets the `set search_path` every other definer function
-- here has; its body already schema-qualifies sku_registry.
--
-- Order: deploy the code first, then apply this. The code works with or
-- without it.
--
-- REVERSAL:
--   grant execute on function public.generate_sku(text, text, text, text, text, text, text, text, int) to public, anon, authenticated;
--   grant execute on function public.next_order_number(text, text) to public, anon, authenticated;
--   alter function public.generate_sku(text, text, text, text, text, text, text, text, int) reset search_path;
--   alter table public.order_counters disable row level security;
--   alter table public.sync_ignored_skus disable row level security;
--
-- Idempotent: safe to re-run. Verify afterwards with
--   select has_function_privilege('anon', 'public.generate_sku(text,text,text,text,text,text,text,text,int)', 'execute');  -- false
--   select has_function_privilege('service_role', 'public.next_order_number(text,text)', 'execute');                     -- true

revoke all on function public.generate_sku(text, text, text, text, text, text, text, text, int)
  from public, anon, authenticated;
revoke all on function public.next_order_number(text, text)
  from public, anon, authenticated;

grant execute on function public.generate_sku(text, text, text, text, text, text, text, text, int) to service_role;
grant execute on function public.next_order_number(text, text) to service_role;

alter function public.generate_sku(text, text, text, text, text, text, text, text, int) set search_path = public;

alter table public.order_counters enable row level security;
alter table public.sync_ignored_skus enable row level security;

-- ----------------------------------------------------------------------------
-- pipeline_jobs staff read (Studio JobsTicker) — audit round 2, 4 Oct.
--
-- 0017's policy matched `staff_users.id = auth.uid()`, but staff_users.id is
-- its own gen_random_uuid() (0001) — addStaffUser inserts without an id and
-- nothing aligns it with auth.users — so the predicate never held for anyone.
-- The ticker (which reads through the anon-key user client) got zero rows, and
-- Realtime filtered every pipeline_jobs event out by the same policy: no
-- progress chips after Generate, no auto-refresh when a job finished.
--
-- Staff are matched by JWT email everywhere else (lib/staff.ts, and every
-- staff policy since 0001 via public.is_active_staff()), so this does the
-- same. Buyers and anon still read nothing: is_active_staff() is true only
-- for an active staff_users row whose email is the caller's JWT email. Writes
-- stay service-role only (still no insert/update/delete policy).
--
-- Expect old chips once applied: the ticker lists the 6 newest queued/claimed/
-- running/error rows with no age limit, and those have been invisible until
-- now (stale error rows, scan_drive/tryon rows queued with no hosted runner).
--
-- REVERSAL (restores 0017's never-matching predicate):
--   drop policy if exists pipeline_jobs_staff_read on public.pipeline_jobs;
--   create policy pipeline_jobs_staff_read on public.pipeline_jobs for select to authenticated
--     using (exists (select 1 from public.staff_users s where s.id = auth.uid() and s.active));
--
-- Idempotent: drop-if-exists + create. Verify afterwards with
--   select qual from pg_policies where tablename = 'pipeline_jobs' and policyname = 'pipeline_jobs_staff_read';  -- is_active_staff()

drop policy if exists pipeline_jobs_staff_read on public.pipeline_jobs;
create policy pipeline_jobs_staff_read on public.pipeline_jobs
  for select to authenticated
  using (public.is_active_staff());
