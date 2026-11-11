-- 0075 — bring generate_sku, next_order_number, order_counters and
-- sync_ignored_skus in line with the house rule that security-definer RPCs and
-- internal tables are service-role only (as in 0046, 0048, 0060).
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
