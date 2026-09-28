-- Wallet sign-in moves to Shopify's email sign-in (28 Sep 2026).
--
-- wallet_signups: the sign-up form a shopper fills BEFORE signing in (name,
-- email, mobile, WhatsApp choice). It is the lead record, and the wallet is
-- opened from it the first time that email signs in. Service role only.
--
-- wallet_otps: the WhatsApp one-time codes are gone with the WhatsApp login.
-- It only ever held hashed, expired codes.

create table if not exists wallet_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,                        -- lower-cased
  name text,
  phone text not null,                        -- E.164 digits, no plus
  wa_opt_in boolean not null default false,
  ip text,
  shopify_customer_id text,                   -- set at sign-up (new customer) or claim
  claimed_at timestamptz,                     -- when their wallet opened from it
  claim_note text,                            -- 'phone-review' | 'phone_in_use' | null
  created_at timestamptz not null default now()
);
create index if not exists wallet_signups_email_idx on wallet_signups (email, created_at desc);
create index if not exists wallet_signups_ip_idx on wallet_signups (ip, created_at desc);
alter table wallet_signups enable row level security;

drop table if exists wallet_otps;
