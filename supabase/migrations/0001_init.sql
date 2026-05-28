-- ============================================================================
-- Drevi Wholesale Portal — initial schema, seed, and RLS
-- Spec v2.2 §4.3 / CLAUDE.md (data model + security)
--
-- Idempotent: safe to run more than once. Run via `npm run db:migrate`
-- (scripts/apply-migration.mjs) or paste into the Supabase SQL editor.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type buyer_status as enum ('pending', 'active', 'suspended', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type buyer_source as enum ('inquiry_form', 'exhibition', 'manual_admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type staff_role as enum ('super_admin', 'admin', 'staff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('submitted', 'confirmed', 'fulfilled', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_source as enum ('portal_self_service', 'exhibition');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audit_event_type as enum (
    'credential_created', 'credential_viewed', 'credential_regenerated',
    'credential_changed', 'credential_shared', 'login_success', 'login_failed',
    'account_suspended', 'account_reactivated', 'account_rejected'
  );
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

-- staff_users — privileged accounts. id is linked to auth.users (see README).
create table if not exists public.staff_users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  name        text,
  role        staff_role not null default 'staff',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- buyers — B2B relationships. Linked to auth.users by EMAIL (see README).
create table if not exists public.buyers (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique not null,
  business_name      text,
  owner_name         text,
  phone              text,
  city               text,
  gstin              text,
  status             buyer_status not null default 'pending',
  source             buyer_source not null,
  encrypted_password bytea,
  approved_by        uuid references public.staff_users(id),
  approved_at        timestamptz,
  captured_by        uuid references public.staff_users(id),
  captured_at        timestamptz default now(),
  rejected_by        uuid references public.staff_users(id),
  rejected_at        timestamptz,
  rejection_reason   text,
  notes              text,
  created_at         timestamptz not null default now()
);
create index if not exists buyers_status_idx on public.buyers (status);
create index if not exists buyers_source_idx on public.buyers (source);

-- orders — shared by buyer and exhibition flows.
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text unique not null,
  buyer_id         uuid not null references public.buyers(id),
  status           order_status not null default 'submitted',
  source           order_source not null,
  assisted_by      uuid references public.staff_users(id),
  exhibition_event text,
  items            jsonb not null default '[]'::jsonb,
  total_amount     numeric(12,2) not null default 0,
  notes            text,
  pdf_url          text,
  pdf_sent_via     text,
  pdf_sent_at      timestamptz,
  submitted_at     timestamptz not null default now(),
  confirmed_at     timestamptz
);
create index if not exists orders_buyer_idx on public.orders (buyer_id);
create index if not exists orders_status_idx on public.orders (status);

-- exhibition_sessions — analytics (fleshed out in Phase 4).
create table if not exists public.exhibition_sessions (
  id          uuid primary key default gen_random_uuid(),
  event_name  text not null,
  started_by  uuid references public.staff_users(id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  orders_count integer not null default 0,
  notes       text,
  created_at  timestamptz not null default now()
);

-- auth_audit_log — every credential / login event. Never stores the password.
create table if not exists public.auth_audit_log (
  id            uuid primary key default gen_random_uuid(),
  buyer_id      uuid references public.buyers(id),
  staff_user_id uuid references public.staff_users(id),
  event_type    audit_event_type not null,
  event_at      timestamptz not null default now(),
  ip_address    text,
  user_agent    text,
  notes         text
);
create index if not exists audit_event_at_idx on public.auth_audit_log (event_at desc);
create index if not exists audit_buyer_idx on public.auth_audit_log (buyer_id);

-- wholesale_products — read layer synced from the Product Master Sheet.
create table if not exists public.wholesale_products (
  sku                text primary key,
  title              text,
  description        text,
  category           text,
  sub_category       text,
  color              text,
  primary_fabric     text,
  wholesale_price    numeric(12,2) not null default 0,
  wholesale_visible  boolean not null default false,
  min_order_qty      integer,
  restockable        boolean not null default false,
  restock_days       integer,
  current_qty        integer not null default 0,
  image_urls         jsonb not null default '[]'::jsonb,
  shopify_product_id text,
  shopify_live_url   text,
  synced_at          timestamptz,
  images_fetched_at  timestamptz
);
create index if not exists wholesale_visible_idx on public.wholesale_products (wholesale_visible);
create index if not exists wholesale_category_idx on public.wholesale_products (category);

-- shopify_tokens — caches the Client Credentials Grant token. Service-role only.
create table if not exists public.shopify_tokens (
  id           text primary key default 'default',
  access_token text not null,
  expires_at   timestamptz not null,
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Seed staff (super_admin / admin / staff). Emails assumed @drevifashion.com —
-- adjust to the real addresses, then create matching Supabase Auth users.
-- ----------------------------------------------------------------------------
insert into public.staff_users (email, name, role) values
  ('ansh@drevifashion.com',    'Ansh',    'super_admin'),
  ('rakesh@drevifashion.com',  'Rakesh',  'admin'),
  ('grishma@drevifashion.com', 'Grishma', 'staff')
on conflict (email) do update set name = excluded.name, role = excluded.role;

-- ----------------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER → bypass RLS to avoid recursion)
-- ----------------------------------------------------------------------------
create or replace function public.jwt_email() returns text
  language sql stable as $$ select nullif(auth.jwt() ->> 'email', '') $$;

create or replace function public.is_active_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_users s
    where s.email = public.jwt_email() and s.active
  ) $$;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_users s
    where s.email = public.jwt_email() and s.active
      and s.role in ('admin', 'super_admin')
  ) $$;

create or replace function public.is_active_buyer() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.buyers b
    where b.email = public.jwt_email() and b.status = 'active'
  ) $$;

create or replace function public.current_buyer_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from public.buyers where email = public.jwt_email() limit 1 $$;

-- ----------------------------------------------------------------------------
-- Row-level security. No client writes anywhere — mutations go through server
-- actions using the service role (which bypasses RLS).
-- ----------------------------------------------------------------------------
alter table public.staff_users         enable row level security;
alter table public.buyers              enable row level security;
alter table public.orders              enable row level security;
alter table public.exhibition_sessions enable row level security;
alter table public.auth_audit_log      enable row level security;
alter table public.wholesale_products  enable row level security;
alter table public.shopify_tokens      enable row level security;

-- wholesale_products: readable by any active buyer or active staff.
drop policy if exists wp_select on public.wholesale_products;
create policy wp_select on public.wholesale_products for select to authenticated
  using (public.is_active_buyer() or public.is_active_staff());

-- buyers: a buyer reads only their own row; staff read all.
drop policy if exists buyers_select on public.buyers;
create policy buyers_select on public.buyers for select to authenticated
  using (email = public.jwt_email() or public.is_active_staff());

-- orders: a buyer reads only their own orders; staff read all.
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated
  using (buyer_id = public.current_buyer_id() or public.is_active_staff());

-- staff_users: readable by active staff (for the admin UI).
drop policy if exists staff_select on public.staff_users;
create policy staff_select on public.staff_users for select to authenticated
  using (public.is_active_staff());

-- exhibition_sessions: staff only.
drop policy if exists exh_select on public.exhibition_sessions;
create policy exh_select on public.exhibition_sessions for select to authenticated
  using (public.is_active_staff());

-- auth_audit_log: admin / super_admin only.
drop policy if exists audit_select on public.auth_audit_log;
create policy audit_select on public.auth_audit_log for select to authenticated
  using (public.is_admin());

-- shopify_tokens: no policies → no anon/authenticated access. Service role only.
