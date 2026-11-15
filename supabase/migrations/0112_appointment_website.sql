-- 0112 — Website bookings.
--
-- Ansh, 15 Nov: the store visit booking box goes on drevifashion.com's
-- /pages/visit, which is also the landing page for the store-visit ads. The
-- box books through /api/appointments/book (docs/WEBSITE-BOOKING-API.md).
--
-- Two columns on appointments:
--   campaign     the ad tags the visitor arrived with (utm_source, utm_campaign,
--                utm_content…, whether there was an fbclid/gclid, the landing
--                path, the referring site), so the team can see which ads bring
--                visits. Also written into the booking's history line.
--   client_hash  a salted one-way hash of the visitor's network (an IPv4
--                address, or an IPv6 /64). It is only compared with itself, to
--                cap how many bookings one place can make in an hour; the
--                address itself is never stored.
--
-- appt_book_web(p, p_hash, p_campaign, p_limits): the website's way in. Under
-- one lock for all website bookings it
--   1. returns the booking already made with this form (same idempotency key),
--   2. returns the booking this number already has at this exact time, if the
--      name matches too (a second tab, a slow network); a different name gets
--      'already_booked' and learns nothing about the booking,
--   3. refuses when the number already has p_limits.phone upcoming website
--      bookings, when this network made p_limits.client in the last hour, or
--      when the website as a whole made p_limits.all in the last hour,
--   4. books through appt_book() (0111) exactly like a staff booking, so
--      capacity is checked under the same per-day lock,
--   5. stores campaign and client_hash on the new booking.
-- Staff bookings never take the website lock, so the two locks cannot deadlock.
--
-- ORDER: after 0110 and 0111. 0111 was revised on 15 Nov (a second look for the
-- idempotency key under the day lock; a stylist-only change checks only that
-- stylist's diary), so apply both: --only=0110,0111,0112 on a fresh database,
-- --only=0111,0112 where 0111 already ran. All of 0111 is create or replace.
-- REVERSAL: drop function if exists appt_book_web(jsonb, text, jsonb, jsonb);
--           alter table appointments drop column if exists campaign, drop column if exists client_hash;
-- PROD (Ansh): DB_TARGET=prod npm run db:migrate -- --only=0110,0111,0112

alter table appointments add column if not exists campaign jsonb;
alter table appointments add column if not exists client_hash text;
create index if not exists appointments_client_hash_idx on appointments (client_hash, created_at) where client_hash is not null;
create index if not exists appointments_web_phone_idx on appointments (phone_e164, starts_at) where source = 'website';
create index if not exists appointments_web_created_idx on appointments (created_at) where source = 'website';

create or replace function appt_book_web(p jsonb, p_hash text, p_campaign jsonb, p_limits jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_start timestamptz := (p->>'starts_at')::timestamptz;
  v_phone text := p->>'phone_e164';
  v_name text := lower(regexp_replace(trim(coalesce(p->>'customer_name', '')), '\s+', ' ', 'g'));
  v_old appointments%rowtype;
  v_n int;
  r jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('appt:web'));

  if p->>'idempotency_key' is not null then
    select * into v_old from appointments where idempotency_key = p->>'idempotency_key';
    if found then
      return jsonb_build_object('ok', true, 'id', v_old.id, 'number', v_old.number, 'replayed', true);
    end if;
  end if;

  select * into v_old from appointments
   where source = 'website' and phone_e164 = v_phone and starts_at = v_start and status in ('requested', 'confirmed', 'arrived')
   limit 1;
  if found then
    if lower(regexp_replace(trim(v_old.customer_name), '\s+', ' ', 'g')) = v_name then
      return jsonb_build_object('ok', true, 'id', v_old.id, 'number', v_old.number, 'replayed', true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'already_booked');
  end if;

  select count(*) into v_n from appointments
   where source = 'website' and phone_e164 = v_phone and status in ('requested', 'confirmed', 'arrived') and starts_at >= now();
  if v_n >= coalesce((p_limits->>'phone')::int, 3) then return jsonb_build_object('ok', false, 'error', 'rate_phone'); end if;

  if p_hash is not null then
    select count(*) into v_n from appointments where client_hash = p_hash and created_at > now() - interval '1 hour';
    if v_n >= coalesce((p_limits->>'client')::int, 6) then return jsonb_build_object('ok', false, 'error', 'rate_client'); end if;
  end if;

  select count(*) into v_n from appointments where source = 'website' and created_at > now() - interval '1 hour';
  if v_n >= coalesce((p_limits->>'all')::int, 60) then return jsonb_build_object('ok', false, 'error', 'rate_all'); end if;

  r := appt_book(p);
  if coalesce((r->>'ok')::boolean, false) and not coalesce((r->>'replayed')::boolean, false) then
    update appointments set campaign = p_campaign, client_hash = p_hash where id = (r->>'id')::uuid;
  end if;
  return r;
end $$;

revoke all on function appt_book_web(jsonb, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function appt_book_web(jsonb, text, jsonb, jsonb) to service_role;
