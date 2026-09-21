-- 0061 — the buyer directory (Ansh, 21 Sep).
--
-- 124 brands were captured on visiting cards at the exhibition. The portal's
-- buyers table held one person per business — one name, one phone — and the
-- cards carry up to three named people each (69 of the 124 have a second, 12 a
-- third), plus socials, a website, a category and a second email.
--
-- Two shapes here, and the split matters:
--
--   buyer_contacts  — PEOPLE. A table, not columns, because contact2_name /
--                     contact3_name caps the business at three forever and a
--                     fourth person has nowhere to go. It is also what makes
--                     de-duplication work: the phone that identifies a brand
--                     is often the SECOND person's, and a per-row phone index
--                     lets any of them match. Six prod buyers were found this
--                     way and ZERO by name — the spellings diverge
--                     ("Riza Boutique" on the card, "Kiza boutique" on the
--                     portal), so the phone is the only reliable key.
--
--   buyers.*        — THE BUSINESS. Category, website, socials, second email:
--                     one per business, so they stay columns.

create table if not exists buyer_contacts (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references buyers(id) on delete cascade,

  first_name  text,
  last_name   text,
  designation text,
  -- Stored E.164 the way buyers.phone already is (+91XXXXXXXXXX), so one
  -- normaliser serves both and a cross-table phone match is a plain equality.
  phone text,
  email text,

  -- The person a call goes to first. Exactly one per buyer is the intent; not
  -- enforced by a constraint because a card can arrive with nobody marked and
  -- refusing the import over it would be the wrong trade.
  is_primary boolean not null default false,
  -- Card order, so "Phone 1 / Phone 2 / Phone 3" survives the round trip.
  position int not null default 0,

  source text,                        -- 'visiting_card', 'manual', …
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists bc_buyer_idx on buyer_contacts (buyer_id, position);
-- The de-dup index: "has this phone been seen on ANY contact of ANY buyer".
create index if not exists bc_phone_idx on buyer_contacts (phone) where phone is not null;
-- One person is not recorded twice on the same buyer.
create unique index if not exists bc_buyer_phone_idx
  on buyer_contacts (buyer_id, phone) where phone is not null;

alter table buyer_contacts enable row level security;
-- Internal table: service-role only, matching the house rule for every other
-- staff-facing table (no policies = no anon/authenticated access).

-- ── The business-level fields the cards carry ──────────────────────────────
alter table buyers add column if not exists category    text;  -- "Products / Category"
alter table buyers add column if not exists website     text;
alter table buyers add column if not exists instagram   text;
alter table buyers add column if not exists facebook    text;
alter table buyers add column if not exists email_alt   text;

-- 60 of the 124 brands handed over more than one card (front and back, or two
-- people's cards). card_image_path stays as the PRIMARY image so every
-- existing reader keeps working untouched; the rest live here.
alter table buyers add column if not exists card_image_paths text[] not null default '{}';

-- Where a record came from, so a directory import is distinguishable from a
-- buyer someone typed in. buyers.source already exists ('exhibition',
-- 'manual_admin'); this records the specific batch.
alter table buyers add column if not exists import_batch text;
create index if not exists buyers_import_batch_idx on buyers (import_batch) where import_batch is not null;
