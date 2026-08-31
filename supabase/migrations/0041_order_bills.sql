-- 0041 — line-level confirmation + split billing (Ansh, 18 Aug).
--
-- A wholesale customer shares a cart; Rakesh confirms what's available, puts
-- the rest on hold with an availability note, bills the confirmed lines NOW,
-- and bills the pending lines later as they arrive — several bills against one
-- order. Line state lives inside orders.items (jsonb: line_state, hold_note,
-- stock_moved, billed_in); this migration adds what jsonb can't carry:
--
--   · order_bills — one row per generated bill, with a full line snapshot so a
--     printed bill never changes retroactively when the order is edited.
--   · orders.lines_rev — optimistic-concurrency counter for items writes; two
--     staff editing line states race on it instead of silently overwriting.

create table if not exists order_bills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  bill_number text not null unique,          -- "<order_number>-B<seq>"
  seq int not null,
  items jsonb not null,                      -- snapshot of the billed lines
  subtotal numeric not null default 0,
  discount_amount numeric not null default 0,
  tax_mode text not null default 'none' check (tax_mode in ('none', 'inclusive', 'exclusive')),
  tax_rate numeric,
  tax_amount numeric not null default 0,
  total numeric not null default 0,
  advance_applied numeric not null default 0, -- order advance shown on this bill (first bill only)
  bill_date date not null,
  pdf_url text,
  created_by text,
  created_at timestamptz not null default now(),
  constraint ob_order_seq_unique unique (order_id, seq)
);
create index if not exists ob_order_idx on order_bills (order_id, seq);
alter table order_bills enable row level security;

alter table orders add column if not exists lines_rev int not null default 0;
