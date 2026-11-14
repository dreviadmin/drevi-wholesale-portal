-- 0110 — Appointments: our own booking system in place of Calendly.
--
-- Ansh, 14 Nov: "We need to build a booking system for videocall
-- appointments/store visits. Lets not depend on calendly." Then: "build the
-- portal one first on priority, since our store visit ads have already
-- started". Staff book the store visits and video calls that come in on
-- WhatsApp, Instagram and the phone; the website booking box comes next and
-- uses the same tables and the same booking function (0111).
--
-- Tables (all service-role only: RLS on, no policies, written from server code):
--   appointment_types      Video call shopping, Store visit, Custom design consultation
--   appointment_hours      weekly opening hours (Mon to Sat 12 to 8 pm, Sun 1 to 7 pm)
--   appointment_closures   closed or special-hours days
--   appointment_blocks     time a stylist (or the whole shop) is busy: walk-ins, a stylist off
--   appointment_settings   one row of switches, read at run time (no redeploy to change)
--   appointment_people     who gets staff WhatsApps, with or without a portal login
--   appointments           the bookings
--   appointment_events     each booking's history, added to and never edited
--   appointment_messages   every WhatsApp/email the system will send or has sent
--
-- Nothing here sends anything. Messages are only sent by /api/cron/appointments
-- when appointment_settings.automation_on is true, and while test_mode is true
-- they go only to test_numbers.
--
-- ORDER: apply this file, then 0111, then deploy the code:
--   DB_TARGET=prod npm run db:migrate -- --only=0110
--   DB_TARGET=prod npm run db:migrate -- --only=0111
-- Until both are applied, the Appointments screens say so and the rest of the
-- portal is unaffected (Home's appointment card hides itself).
--
-- IF IT WAS APPLIED FIRST BY MISTAKE: harmless. The old code never reads these tables.
--
-- REVERSAL: drop table appointment_messages, appointment_events, appointments,
--   appointment_people, appointment_settings, appointment_blocks,
--   appointment_closures, appointment_hours, appointment_types; drop sequence
--   appointment_number_seq. (Bookings and their history are lost.)

create extension if not exists pgcrypto;

create table if not exists appointment_types (
  id             text primary key,
  name           text not null unique,
  short_name     text not null,
  minutes        int  not null check (minutes between 5 and 480),
  group_minutes  int  not null check (group_minutes between 5 and 480),
  buffer_minutes int  not null default 0 check (buffer_minutes between 0 and 120),
  notice_hours   int  not null default 1 check (notice_hours between 0 and 720),
  window_days    int  not null default 60 check (window_days between 1 and 366),
  places         text[] not null check (array_length(places, 1) >= 1 and places <@ array['store', 'wa', 'meet']),
  active         boolean not null default true,
  sort           int not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists appointment_hours (
  weekday smallint primary key check (weekday between 0 and 6),   -- 0 = Sunday
  opens   time,
  closes  time,
  check ((opens is null and closes is null) or (opens is not null and closes is not null and closes > opens))
);

create table if not exists appointment_closures (
  day        date primary key,
  opens      time,               -- both null = closed all day
  closes     time,
  note       text,
  created_by text,
  created_at timestamptz not null default now(),
  check ((opens is null and closes is null) or (opens is not null and closes is not null and closes > opens))
);

create table if not exists appointment_blocks (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  takes      int not null default 1 check (takes between 1 and 99),   -- stylists it uses; 99 = the whole shop
  note       text,
  created_by text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists appointment_blocks_time_idx on appointment_blocks (starts_at);

create table if not exists appointment_settings (
  id              smallint primary key default 1 check (id = 1),
  stylists        int  not null default 2 check (stylists between 1 and 20),
  step_minutes    int  not null default 30 check (step_minutes in (15, 30, 60)),
  website_confirm text not null default 'instant' check (website_confirm in ('instant', 'staff')),
  automation_on   boolean not null default false,
  test_mode       boolean not null default true,
  test_numbers    text[] not null default '{}',
  digest_hour     smallint not null default 11 check (digest_hour between 6 and 12),
  updated_at      timestamptz not null default now(),
  updated_by      text
);

create table if not exists appointment_people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  staff_id    uuid references staff_users (id) on delete set null,
  wa_e164     text check (wa_e164 is null or wa_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email       text,
  on_new      boolean not null default true,
  on_change   boolean not null default true,
  on_digest   boolean not null default true,
  on_heads_up boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create sequence if not exists appointment_number_seq start 1001;

create table if not exists appointments (
  id               uuid primary key default gen_random_uuid(),
  number           text not null unique,
  type_id          text not null references appointment_types (id),
  place            text not null check (place in ('store', 'wa', 'meet')),
  party            text not null default 'solo' check (party in ('solo', 'group')),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'confirmed' check (status in ('requested', 'confirmed', 'arrived', 'done', 'no_show', 'cancelled')),
  source           text not null check (source in ('website', 'phone', 'whatsapp', 'instagram', 'walkin', 'other')),
  customer_name    text not null check (length(trim(customer_name)) between 1 and 120),
  phone_e164       text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email            text check (email is null or length(email) <= 200),
  functions        text[] not null default '{}',
  function_date    text check (function_date is null or length(function_date) <= 60),
  looking_for      text check (looking_for is null or length(looking_for) <= 600),
  staff_notes      text check (staff_notes is null or length(staff_notes) <= 2000),
  meet_link        text check (meet_link is null or meet_link ~ '^https://'),
  host_staff_id    uuid references staff_users (id) on delete set null,
  notify_wa        boolean not null default true,
  notify_email     boolean not null default false,
  offers_ok        boolean not null default false,
  outcome          text,
  cancel_reason    text,
  manage_token     text not null unique,
  idempotency_key  text unique,
  created_by       uuid references staff_users (id) on delete set null,
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  cancelled_at     timestamptz,
  updated_at       timestamptz not null default now(),
  rev              int not null default 1,
  check (ends_at > starts_at)
);
create index if not exists appointments_starts_idx on appointments (starts_at);
create index if not exists appointments_phone_idx on appointments (phone_e164);
create index if not exists appointments_live_idx on appointments (starts_at) where status in ('requested', 'confirmed', 'arrived');

create table if not exists appointment_events (
  id             bigserial primary key,
  appointment_id uuid not null references appointments (id) on delete cascade,
  at             timestamptz not null default now(),
  by_name        text not null,
  by_staff_id    uuid references staff_users (id) on delete set null,
  kind           text not null,
  text           text not null
);
create index if not exists appointment_events_appt_idx on appointment_events (appointment_id, at);

create table if not exists appointment_messages (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid references appointments (id) on delete cascade,   -- null for the daily list
  dedupe_key     text not null unique,
  rule           text not null,
  template       text not null,
  channel        text not null check (channel in ('wa', 'email')),
  audience       text not null check (audience in ('client', 'staff')),
  recipient_name text,
  to_address     text not null,
  params         jsonb not null default '{}',
  due_at         timestamptz not null,
  expires_at     timestamptz,
  state          text not null default 'scheduled' check (state in ('scheduled', 'sending', 'sent', 'failed', 'uncertain', 'cancelled', 'skipped')),
  reason         text,
  attempts       int not null default 0,
  provider_ref   text,
  last_error     text,
  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists appointment_messages_due_idx on appointment_messages (due_at) where state = 'scheduled';
create index if not exists appointment_messages_appt_idx on appointment_messages (appointment_id);

alter table appointment_types    enable row level security;
alter table appointment_hours    enable row level security;
alter table appointment_closures enable row level security;
alter table appointment_blocks   enable row level security;
alter table appointment_settings enable row level security;
alter table appointment_people   enable row level security;
alter table appointments         enable row level security;
alter table appointment_events   enable row level security;
alter table appointment_messages enable row level security;

-- Starting rows. Only inserted when missing, so a replay never overwrites Settings.
insert into appointment_types (id, name, short_name, minutes, group_minutes, buffer_minutes, notice_hours, window_days, places, sort) values
  ('store',  'Store visit',                'Store visit',   30, 45, 0,  1,  60, array['store'],              1),
  ('video',  'Video call shopping',        'Video call',    30, 45, 0,  2,  60, array['wa', 'meet'],         2),
  ('design', 'Custom design consultation', 'Custom design', 45, 45, 15, 24, 60, array['store', 'wa', 'meet'], 3)
on conflict (id) do nothing;

insert into appointment_hours (weekday, opens, closes) values
  (0, '13:00', '19:00'), (1, '12:00', '20:00'), (2, '12:00', '20:00'), (3, '12:00', '20:00'),
  (4, '12:00', '20:00'), (5, '12:00', '20:00'), (6, '12:00', '20:00')
on conflict (weekday) do nothing;

-- AiSensy campaign names per template (template name -> Live API campaign), filled in Settings once approved.
alter table appointment_settings add column if not exists campaigns jsonb not null default '{}';

insert into appointment_settings (id) values (1) on conflict (id) do nothing;

alter type public.audit_event_type add value if not exists 'appointment_settings_changed';

comment on table appointments is 'Store visits, video calls and custom design consultations (0110). Booked only through appt_book() (0111).';
comment on table appointment_messages is 'Outbox for appointment WhatsApps/emails (0110). Sent only by /api/cron/appointments when appointment_settings.automation_on.';

notify pgrst, 'reload schema';
