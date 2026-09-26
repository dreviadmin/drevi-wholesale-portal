-- 0068 — the Drevi Wallet (Ansh, 26 Sep 2026).
--
-- A store credit balance for retail customers, keyed on PHONE. Shopify's own
-- store credit only works inside a Shopify customer account, which logs in by
-- email — and 217 of the 222 retail customers have a phone and no email. So
-- the wallet lives here, the customer logs in with a WhatsApp code, and value
-- is settled at checkout as a single-use discount code minted for that cart.
--
-- Rules the tables encode (decided 26 Sep):
--   * ₹1,000 welcome on the wallet's creation, one per phone, everyone.
--   * 10% of the amount actually PAID on every order that is both fulfilled
--     and paid — not on order placement, because COD parcels get refused.
--   * Rolling 12-month expiry: every credit pushes expires_at out again, so an
--     active customer never loses anything and a dormant wallet lapses.
--   * ₹5,000 minimum order to redeem.
--
-- Money is INTEGER PAISE throughout. Shopify hands us decimal strings; the
-- conversion happens once at the edge (wallet-core.ts) and nothing here ever
-- holds a fractional rupee. Balance is denormalised onto the account and every
-- ledger row carries balance_after, so a statement reads without a running
-- sum and a mismatch between the two is detectable.

create table if not exists wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,                 -- E.164 digits, no plus: 919876543210
  shopify_customer_id text,                   -- gid://shopify/Customer/…, once linked
  name text,
  balance_paise bigint not null default 0 check (balance_paise >= 0),
  expires_at timestamptz,                     -- rolling; null only while balance is 0
  wa_opt_in_at timestamptz,                   -- when they ticked the WhatsApp box
  source text not null default 'seed'
    check (source in ('seed', 'popup', 'order', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wallet_accounts_customer_idx on wallet_accounts (shopify_customer_id);
create index if not exists wallet_accounts_expiry_idx on wallet_accounts (expires_at) where balance_paise > 0;

-- Every movement, signed. Additive only: a reversal is a new row underneath
-- the thing it reverses, never an edit, so the statement tells the whole story.
create table if not exists wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references wallet_accounts (id) on delete restrict,
  kind text not null check (kind in (
    'welcome',          -- +  the ₹1,000
    'earn',             -- +  10% of an order, once fulfilled and paid
    'redeem',           -- -  spent on an order
    'reverse_redeem',   -- +  that order was cancelled: money back
    'reverse_earn',     -- -  that order was cancelled or refunded: earning back
    'expire',           -- -  lapsed after 12 idle months
    'adjust'            -- ±  a human correction, note required
  )),
  amount_paise bigint not null,               -- signed: credits positive, debits negative
  balance_after_paise bigint not null check (balance_after_paise >= 0),
  ref_type text,                              -- 'shopify_order' | 'refund' | 'redemption' | 'seed'
  ref_id text,                                -- the gid / id that ref_type names
  note text,
  created_at timestamptz not null default now()
);
create index if not exists wallet_ledger_account_idx on wallet_ledger (account_id, created_at desc);
-- Idempotency: a webhook that arrives twice, or a seed that is re-run, must
-- not post the same movement twice. One row per (account, kind, reference).
create unique index if not exists wallet_ledger_once_idx
  on wallet_ledger (account_id, kind, ref_type, ref_id) where ref_id is not null;

-- A minted discount code, waiting for an order. 'open' reserves the amount
-- against the balance (so two carts cannot both spend it) without debiting;
-- the debit is posted when the order actually arrives, for what was actually
-- applied. Anything still open past expires_at is dead and releases.
create table if not exists wallet_redemptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references wallet_accounts (id) on delete restrict,
  code text not null unique,                  -- WLT-XXXXXXXX
  amount_paise bigint not null check (amount_paise > 0),
  shopify_discount_id text,                   -- gid://shopify/DiscountCodeNode/…
  cart_token text,
  status text not null default 'open' check (status in ('open', 'used', 'expired', 'void')),
  expires_at timestamptz not null,
  shopify_order_id text,                      -- set when used
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists wallet_redemptions_open_idx
  on wallet_redemptions (account_id) where status = 'open';

-- WhatsApp one-time codes. Only a hash is stored; the code itself goes to the
-- phone and nowhere else. Rows double as the rate-limit record.
create table if not exists wallet_otps (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists wallet_otps_phone_idx on wallet_otps (phone, created_at desc);
create index if not exists wallet_otps_ip_idx on wallet_otps (ip, created_at desc);

-- Shopify retries webhooks it thinks failed. The delivery id makes a retry a
-- no-op instead of a second credit.
create table if not exists wallet_webhook_events (
  id text primary key,                        -- X-Shopify-Webhook-Id
  topic text not null,
  shopify_order_id text,
  received_at timestamptz not null default now()
);

-- The one write path. Locks the account row, applies the signed amount,
-- writes the ledger row and the new balance together, and extends the
-- rolling expiry on a credit. A duplicate (same account, kind, reference)
-- returns NULL and changes nothing — that is how a retried webhook or a
-- re-run seed is a no-op rather than a double post. p_clamp lets a debit
-- that outruns the balance (an expiry, a reversal) take it to zero instead
-- of failing; every other debit that would go negative raises.
create or replace function wallet_post_movement(
  p_account uuid,
  p_kind text,
  p_amount bigint,
  p_ref_type text default null,
  p_ref_id text default null,
  p_note text default null,
  p_clamp boolean default false,
  p_expiry_months int default 12
) returns wallet_ledger
language plpgsql
as $$
declare
  v_balance bigint;
  v_after bigint;
  v_applied bigint;
  v_row wallet_ledger;
begin
  select balance_paise into v_balance from wallet_accounts where id = p_account for update;
  if not found then
    raise exception 'wallet account % not found', p_account;
  end if;

  if p_ref_id is not null and exists (
    select 1 from wallet_ledger
     where account_id = p_account and kind = p_kind
       and ref_type is not distinct from p_ref_type and ref_id = p_ref_id
  ) then
    return null;
  end if;

  v_applied := p_amount;
  v_after := v_balance + p_amount;
  if v_after < 0 then
    if p_clamp then
      v_applied := -v_balance;
      v_after := 0;
    else
      raise exception 'movement % would take balance % below zero', p_amount, v_balance;
    end if;
  end if;

  insert into wallet_ledger (account_id, kind, amount_paise, balance_after_paise, ref_type, ref_id, note)
  values (p_account, p_kind, v_applied, v_after, p_ref_type, p_ref_id, p_note)
  returning * into v_row;

  update wallet_accounts
     set balance_paise = v_after,
         updated_at = now(),
         expires_at = case
           when v_applied > 0 then now() + make_interval(months => p_expiry_months)
           when v_after = 0 then null
           else expires_at
         end
   where id = p_account;

  return v_row;
end;
$$;

-- No RLS policies: these tables are only ever touched by the service-role
-- client from route handlers that have already checked the caller's session
-- token or the webhook HMAC. Enabling RLS with no policies makes the anon key
-- see nothing, which is the intent.
alter table wallet_accounts enable row level security;
alter table wallet_ledger enable row level security;
alter table wallet_redemptions enable row level security;
alter table wallet_otps enable row level security;
alter table wallet_webhook_events enable row level security;
