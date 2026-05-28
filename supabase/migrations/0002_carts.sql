-- ============================================================================
-- Phase 2 — buyer cart (Supabase-persisted, so a cart survives reloads and
-- device switches). One row per buyer; items is a [{sku, qty}] array. Writes
-- go through server actions (service role); buyers may read only their own.
-- Idempotent.
-- ============================================================================

create table if not exists public.carts (
  buyer_id   uuid primary key references public.buyers(id) on delete cascade,
  items      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.carts enable row level security;

drop policy if exists carts_select on public.carts;
create policy carts_select on public.carts for select to authenticated
  using (buyer_id = public.current_buyer_id());
