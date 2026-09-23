-- 0067 — a buyer must never learn an agent exists (Ansh, 23 Sep: "no, the
-- buyer needs not see it").
--
-- 0064 bolted agent_id and agent_commission_pct onto `orders` and agent_id
-- onto `buyers`. RLS on those two tables lets a buyer read their OWN rows, and
-- PostgREST hands back every column of a row it lets you see — so any
-- logged-in buyer could ask for orders.agent_commission_pct and be told what
-- their agent earns on them.
--
-- Column-level REVOKE does not fix it: a table-level SELECT grant supersedes a
-- column revoke, which is exactly what the first version of this migration ran
-- into — the revoke applied cleanly and the column stayed readable. The
-- alternative, revoking the table grant and re-granting every other column by
-- name, works until the next migration adds a column nobody remembers to
-- grant, and then the buyer portal breaks instead.
--
-- So the association moves to its own tables, which is how every other
-- staff-only fact in this schema is already protected: RLS on, no policies, so
-- anon and authenticated simply cannot see the table exists. Nothing to
-- enumerate and nothing for a future column to undo.

create table if not exists order_agents (
  order_id uuid primary key references orders(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete restrict,
  commission_pct numeric(5,2) not null
    check (commission_pct >= 0 and commission_pct <= 100),
  set_by text,
  set_at timestamptz not null default now()
);
create index if not exists order_agents_agent_idx on order_agents (agent_id);

create table if not exists buyer_agents (
  buyer_id uuid primary key references buyers(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete restrict,
  set_by text,
  set_at timestamptz not null default now()
);
create index if not exists buyer_agents_agent_idx on buyer_agents (agent_id);

-- Carry over anything 0064 already recorded. Dev has had test rows; prod has
-- never had these columns at all.
insert into order_agents (order_id, agent_id, commission_pct)
select id, agent_id, coalesce(agent_commission_pct, 0) from orders where agent_id is not null
on conflict (order_id) do nothing;

insert into buyer_agents (buyer_id, agent_id)
select id, agent_id from buyers where agent_id is not null
on conflict (buyer_id) do nothing;

alter table orders drop column if exists agent_id;
alter table orders drop column if exists agent_commission_pct;
alter table buyers drop column if exists agent_id;

alter table order_agents enable row level security;
alter table buyer_agents enable row level security;
-- No policies, deliberately: service-role only, like agents and their ledger.
