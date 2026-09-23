-- 0064 — agents and their commission (Ansh, 23 Sep).
--
-- An agent introduces a buyer and earns a percentage of what that buyer's
-- orders are worth. Four shapes, and the reasons each is what it is:
--
--  * agents            — the person. NO balance column. Two caches in this
--                        codebase have already drifted from the ledger behind
--                        them (current_qty vs stock_movements, and the grant
--                        row 0046's header describes), and a commission
--                        balance is read far less often than it is written to.
--                        It is derived, every time.
--
--  * agent_commissions — one row per order, written when the order reaches a
--                        terminal state. A SNAPSHOT, not a view: orders stay
--                        editable after delivery (updateOrderItems is open to
--                        every status but cancelled and rewrites total_amount,
--                        the discount, the tax and the advance), so a figure
--                        derived live would move under an agent's feet with
--                        nothing recording that it had. The row also pins the
--                        orders.lines_rev it was computed at, which is what
--                        lets a later edit surface as an explicit adjustment
--                        rather than a silently different number.
--
--  * agent_adjustments — everything that changes what was earned AFTER the
--                        accrual: a return, a post-accrual order edit, a
--                        manual correction. Additive and signed, never an
--                        UPDATE of the original row, for the same reason a
--                        cancelled bill is kept rather than deleted.
--
--  * agent_payments    — money actually paid out. Consumption only, exactly
--                        as credit_ledger is to credit_notes.
--
-- EARNED IS NOT PAYABLE (Ansh's first answer). Commission is earned when the
-- order is delivered, but 87% of delivered value on prod is still outstanding
-- (₹8.87L of ₹10.19L), so paying on delivery would fund agents out of pocket.
-- Payable is the earned amount scaled by the share of the order the buyer has
-- actually paid. Both figures are shown; only payable gates a payout.

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  city text,
  address text,
  -- The default applied to a new order; the order keeps its own copy, so
  -- changing this never rewrites history.
  default_commission_pct numeric(5,2) not null default 0
    check (default_commission_pct >= 0 and default_commission_pct <= 100),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now()
);

create index if not exists agents_active_idx on agents (active, name);

-- A buyer's standing agent. The ORDER still carries its own agent_id — this is
-- only what the confirmation dialog pre-fills from.
alter table buyers add column if not exists agent_id uuid references agents(id) on delete set null;
create index if not exists buyers_agent_idx on buyers (agent_id) where agent_id is not null;

-- Set by Rakesh when he CONFIRMS the order, not when it is placed: every order
-- in the book — in-store, exhibition and portal alike — is created as
-- 'submitted', and all 25 terminal orders passed through confirmed_at, so
-- confirmation is the one gate everything crosses.
alter table orders add column if not exists agent_id uuid references agents(id) on delete set null;
alter table orders add column if not exists agent_commission_pct numeric(5,2)
  check (agent_commission_pct is null or (agent_commission_pct >= 0 and agent_commission_pct <= 100));
create index if not exists orders_agent_idx on orders (agent_id) where agent_id is not null;

create table if not exists agent_commissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete restrict,
  order_id uuid not null references orders(id) on delete restrict,

  -- What the commission was charged on, in words a person can check:
  --   base = (total_amount − tax_amount) less any held/pending line
  -- total_amount − tax_amount is the only expression correct in all three tax
  -- modes; under 'inclusive' the net figure still contains the GST, and paying
  -- commission on tax the house remits to the government is not a rounding
  -- error. Held and pending lines are excluded because updateOrderItems sums
  -- every line into total_amount while billing deliberately bills only the
  -- confirmed ones — one terminal order on prod carries ₹6,195 of goods that
  -- never left the building.
  commission_base numeric(12,2) not null,
  commission_pct  numeric(5,2)  not null,
  commission_amount numeric(12,2) not null,

  -- The revision the base was computed at. Every writer of orders.items bumps
  -- this, so a later edit is detectable rather than invisible.
  lines_rev integer not null default 0,

  -- Which terminal state triggered it. 'fulfilled' is the legacy one and all
  -- ten such orders on prod have delivered_at NULL, so the trigger cannot key
  -- on that date.
  accrued_on text not null check (accrued_on in ('delivered', 'fulfilled')),
  accrued_at timestamptz not null default now(),
  accrued_by text,

  -- One accrual per order. A re-entry into a terminal state must not pay twice.
  unique (order_id)
);

create index if not exists agent_commissions_agent_idx on agent_commissions (agent_id, accrued_at desc);

create table if not exists agent_adjustments (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete restrict,
  order_id uuid references orders(id) on delete restrict,
  commission_id uuid references agent_commissions(id) on delete restrict,

  -- Signed: negative claws back, positive adds. Never an UPDATE of the accrual.
  delta numeric(12,2) not null,
  reason text not null check (reason in ('return', 'order_revised', 'manual', 'correction')),
  note text,
  -- The credit note that caused it, so a return can never be counted twice.
  credit_note_id uuid references credit_notes(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by text,

  -- One adjustment per credit note per agent: the guard that stops a re-run
  -- clawing back the same return again.
  unique (agent_id, credit_note_id)
);

create index if not exists agent_adjustments_agent_idx on agent_adjustments (agent_id, created_at desc);

create table if not exists agent_payments (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  method text,
  reference text,
  paid_on date not null default current_date,
  note text,

  -- Voided, not deleted — the same rule every other money document here
  -- follows.
  voided_at timestamptz,
  voided_by text,
  void_reason text,

  -- Idempotency for the record-payment dialog, exactly as settle_return does.
  client_ref text unique,
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists agent_payments_agent_idx on agent_payments (agent_id, paid_on desc);

alter table agents            enable row level security;
alter table agent_commissions enable row level security;
alter table agent_adjustments enable row level security;
alter table agent_payments    enable row level security;
-- Service-role only, like every other staff-facing table: no policies means no
-- anon or authenticated access. A buyer must never see that an agent exists on
-- their order (Ansh, 23 Sep).
