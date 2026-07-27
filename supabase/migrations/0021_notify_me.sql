-- Stage 9 (build guide §13, guide file 0020 → repo 0021 per DECISIONS):
-- back-in-stock requests. Buyer-scoped: a buyer may read/insert their OWN
-- rows; staff read everything through the service role.

create table if not exists notify_me (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references buyers(id) on delete cascade,
  sku_base text not null,
  color text not null,
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz
);

create unique index if not exists notify_me_open_unique
  on notify_me (buyer_id, sku_base, color)
  where fulfilled_at is null;
create index if not exists notify_me_group_idx on notify_me (sku_base, color) where fulfilled_at is null;

alter table notify_me enable row level security;

-- current_buyer_id() already exists (migration 0007+) and resolves the
-- credentialed buyer row for the signed-in user.
do $$ begin
  create policy notify_me_own_select on notify_me
    for select to authenticated using (buyer_id = current_buyer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy notify_me_own_insert on notify_me
    for insert to authenticated with check (buyer_id = current_buyer_id());
exception when duplicate_object then null; end $$;
