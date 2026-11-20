-- 0113 — Appointment WhatsApps: checked every 5 minutes by the database.
--
-- Ansh, 20 Nov: the 2-hour reminder for a store visit never went. The sender
-- (/api/cron/appointments) was called only by the GitHub "every 10 minutes"
-- schedule, and GitHub ran that schedule only every 5 to 8 hours (04:52,
-- 09:36 and 18:15 IST on 20 Nov). The reminder was due at 14:00 and too late
-- to send after 15:45, with no run in between. The day-before reminder went
-- 6 hours late for the same reason, and the 11 am daily list never went.
--
-- From here the database calls the sender itself, every 5 minutes, with
-- pg_cron (the schedule) and pg_net (the HTTP call):
--
--   appointment_sender   one row: where the portal is (url), the token the
--                        call carries, and when the scheduled check last ran.
--                        The portal fills in url itself, from its production
--                        address, the first time the sender or the Settings
--                        page runs after this migration (dev and prod each
--                        get their own). Until then the job does nothing.
--   appt_kick_sender()   one POST to <url>/api/cron/appointments carrying the
--                        token. The route accepts it as well as the cron
--                        secret GitHub sends (GitHub stays as a backstop).
--   appt_claim_messages_for(id, n)
--                        the due messages of one booking only, so a booking
--                        made in the portal or on the website sends its
--                        confirmation and team alerts straight away.
--
-- The token is made here, inside the database, and is read only with the
-- service role (RLS on, no policies, no grants), so nothing secret is typed
-- anywhere and nothing secret is in this file.
--
-- ORDER: after 0110-0112. Safe to run twice (cron.schedule replaces the job of
-- the same name).
-- PROD (Ansh): DB_TARGET=prod npm run db:migrate -- --only=0113
-- REVERSAL: select cron.unschedule('appointment-messages');
--           drop function if exists appt_kick_sender(); drop function if exists appt_claim_messages_for(uuid, int);
--           drop table if exists appointment_sender;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

create table if not exists appointment_sender (
  id int primary key default 1 check (id = 1),
  url text check (url is null or url ~ '^https://[A-Za-z0-9.-]+$'),
  token text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  last_run_at timestamptz,
  last_via text,
  last_result jsonb,
  updated_at timestamptz not null default now()
);
insert into appointment_sender (id) values (1) on conflict (id) do nothing;
alter table appointment_sender enable row level security;
revoke all on appointment_sender from public, anon, authenticated;

create or replace function appt_kick_sender() returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v appointment_sender%rowtype;
begin
  select * into v from appointment_sender where id = 1;
  if not found or v.url is null then return null; end if;
  return net.http_post(
    url := v.url || '/api/cron/appointments',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Appointments-Sender', v.token),
    timeout_milliseconds := 60000
  );
end $$;

create or replace function appt_claim_messages_for(p_appointment uuid, p_limit int) returns setof appointment_messages
language plpgsql security definer set search_path = public as $$
begin
  return query
    update appointment_messages m set state = 'sending', attempts = m.attempts + 1, updated_at = now()
     where m.id in (
       select id from appointment_messages
        where appointment_id = p_appointment and state = 'scheduled' and due_at <= now()
          and (expires_at is null or expires_at >= now())
        order by due_at limit p_limit for update skip locked)
    returning m.*;
end $$;

revoke all on function appt_kick_sender() from public, anon, authenticated;
revoke all on function appt_claim_messages_for(uuid, int) from public, anon, authenticated;
grant execute on function appt_claim_messages_for(uuid, int) to service_role;

select cron.schedule('appointment-messages', '*/5 * * * *', 'select public.appt_kick_sender()');
