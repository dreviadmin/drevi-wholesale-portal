-- 0111 — The appointment booking functions.
--
-- Every booking, change, cancel and status move goes through these, so the
-- capacity check, the history row and the message plan happen together or not
-- at all. The portal (and later the website) only calls them with the service
-- role; nobody else can execute them.
--
--   appt_conflict(...)          the busiest moment inside a time window, against capacity
--   appt_apply_messages(id, m)  replace a booking's waiting messages with a new plan
--   appt_book(p)                book (idempotent on idempotency_key)
--   appt_update(p)              change anything on a booking (time, status, details), rev-checked
--   appt_claim_messages(n)      the sender takes the messages that are due
--
-- Capacity: at no moment inside the new booking (plus its gap after) may the
-- live bookings and blocks running at that moment reach appointment_settings.stylists.
-- A video call may not overlap another video call. A stylist may not be on two
-- bookings at once. Staff may book over the limit with override = true; the
-- portal allows that to owners and admins only.
--
-- One day is locked at a time (pg_advisory_xact_lock on the IST date), so two
-- people pressing Book for the same slot are served one after the other.
--
-- ORDER: after 0110 (needs its tables). REVERSAL: drop the five functions.

create or replace function appt_conflict(
  p_exclude uuid, p_type text, p_start timestamptz, p_end timestamptz, p_place text, p_host uuid
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_buf int;
  v_cap int;
  v_win_end timestamptz;
  v_peak int;
begin
  select buffer_minutes into v_buf from appointment_types where id = p_type;
  select stylists into v_cap from appointment_settings where id = 1;
  v_cap := coalesce(v_cap, 2);
  v_win_end := p_end + make_interval(mins => coalesce(v_buf, 0));

  with iv as (
    select a.starts_at s, a.ends_at + make_interval(mins => t.buffer_minutes) e, 1 w
      from appointments a join appointment_types t on t.id = a.type_id
     where a.status in ('requested', 'confirmed', 'arrived')
       and (p_exclude is null or a.id <> p_exclude)
       and a.starts_at < v_win_end and p_start < a.ends_at + make_interval(mins => t.buffer_minutes)
    union all
    select b.starts_at, b.ends_at, b.takes from appointment_blocks b
     where b.starts_at < v_win_end and p_start < b.ends_at
  ), pts as (
    select p_start t
    union
    select s from iv where s > p_start and s < v_win_end
  )
  select coalesce(max((select coalesce(sum(w), 0) from iv where iv.s <= pts.t and pts.t < iv.e)), 0) into v_peak from pts;
  if v_peak >= v_cap then return 'full'; end if;

  if p_place in ('wa', 'meet') and exists (
    select 1 from appointments a
     where a.status in ('requested', 'confirmed', 'arrived') and (p_exclude is null or a.id <> p_exclude)
       and a.place in ('wa', 'meet') and a.starts_at < p_end and p_start < a.ends_at
  ) then return 'video_busy'; end if;

  if p_host is not null and exists (
    select 1 from appointments a
     where a.status in ('requested', 'confirmed', 'arrived') and (p_exclude is null or a.id <> p_exclude)
       and a.host_staff_id = p_host and a.starts_at < p_end and p_start < a.ends_at
  ) then return 'host_busy'; end if;

  return null;
end $$;

-- Replace a booking's plan. Event rows (rule ev-*: moved, cancelled) stay as queued. Rows already sent, sending, failed or uncertain are
-- never touched again; waiting rows not in the new plan are cancelled; a row
-- that comes back into the plan (e.g. moved back to the old time) is revived.
create or replace function appt_apply_messages(p_id uuid, p_msgs jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  update appointment_messages
     set state = 'cancelled', reason = 'No longer needed', updated_at = now()
   where appointment_id = p_id and state in ('scheduled', 'skipped')
     and rule not like 'ev-%'   -- event messages (moved, cancelled) are never withdrawn by a later edit
     and dedupe_key <> all (array(select p_id::text || ':' || (m->>'key') from jsonb_array_elements(coalesce(p_msgs, '[]'::jsonb)) m));

  insert into appointment_messages (appointment_id, dedupe_key, rule, template, channel, audience, recipient_name, to_address, params, due_at, expires_at, state, reason)
  select p_id, p_id::text || ':' || (m->>'key'), m->>'rule', m->>'template', m->>'channel', m->>'audience', m->>'recipient_name', m->>'to_address',
         coalesce(m->'params', '{}'::jsonb), (m->>'due_at')::timestamptz, nullif(m->>'expires_at', '')::timestamptz,
         coalesce(m->>'state', 'scheduled'), m->>'reason'
    from jsonb_array_elements(coalesce(p_msgs, '[]'::jsonb)) m
  on conflict (dedupe_key) do update set
    state = case when appointment_messages.state in ('scheduled', 'cancelled', 'skipped') then excluded.state else appointment_messages.state end,
    reason = case when appointment_messages.state in ('scheduled', 'cancelled', 'skipped') then excluded.reason else appointment_messages.reason end,
    recipient_name = excluded.recipient_name, params = excluded.params, expires_at = excluded.expires_at, updated_at = now();
end $$;

create or replace function appt_lock_day(p_at timestamptz) returns void
language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtext('appt:' || ((p_at at time zone 'Asia/Kolkata')::date)::text));
$$;

-- search_path includes extensions: Supabase keeps pgcrypto's gen_random_bytes there.
create or replace function appt_book(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_old appointments%rowtype;
  v_type appointment_types%rowtype;
  v_start timestamptz := (p->>'starts_at')::timestamptz;
  v_end timestamptz := (p->>'ends_at')::timestamptz;
  v_place text := p->>'place';
  v_host uuid := nullif(p->>'host_staff_id', '')::uuid;
  v_conflict text;
  v_id uuid;
  v_number text;
  v_token text;
begin
  if p->>'idempotency_key' is not null then
    select * into v_old from appointments where idempotency_key = p->>'idempotency_key';
    if found then
      return jsonb_build_object('ok', true, 'id', v_old.id, 'number', v_old.number, 'token', v_old.manage_token, 'rev', v_old.rev, 'replayed', true);
    end if;
  end if;

  select * into v_type from appointment_types where id = p->>'type_id';
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_type'); end if;
  if not (v_place = any (v_type.places)) then return jsonb_build_object('ok', false, 'error', 'bad_place'); end if;
  if v_end <= v_start then return jsonb_build_object('ok', false, 'error', 'bad_time'); end if;

  perform appt_lock_day(v_start);
  -- Look again under the lock: two taps of the same form wait here one after the other,
  -- and the second must get the first one's booking, not an error.
  if p->>'idempotency_key' is not null then
    select * into v_old from appointments where idempotency_key = p->>'idempotency_key';
    if found then
      return jsonb_build_object('ok', true, 'id', v_old.id, 'number', v_old.number, 'token', v_old.manage_token, 'rev', v_old.rev, 'replayed', true);
    end if;
  end if;
  v_conflict := appt_conflict(null, v_type.id, v_start, v_end, v_place, v_host);
  if v_conflict is not null and not coalesce((p->>'override')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_conflict);
  end if;

  v_number := 'A-' || nextval('appointment_number_seq');
  v_token := translate(rtrim(encode(gen_random_bytes(18), 'base64'), '='), '+/', '-_');

  insert into appointments (number, type_id, place, party, starts_at, ends_at, status, source, customer_name, phone_e164, email,
                            functions, function_date, looking_for, staff_notes, meet_link, host_staff_id, notify_wa, notify_email,
                            offers_ok, manage_token, idempotency_key, created_by, confirmed_at)
  values (v_number, v_type.id, v_place, coalesce(p->>'party', 'solo'), v_start, v_end, coalesce(p->>'status', 'confirmed'), p->>'source',
          trim(p->>'customer_name'), p->>'phone_e164', nullif(trim(coalesce(p->>'email', '')), ''),
          coalesce(array(select jsonb_array_elements_text(p->'functions')), '{}'), nullif(trim(coalesce(p->>'function_date', '')), ''),
          nullif(trim(coalesce(p->>'looking_for', '')), ''), nullif(trim(coalesce(p->>'staff_notes', '')), ''), nullif(p->>'meet_link', ''),
          v_host, coalesce((p->>'notify_wa')::boolean, true), coalesce((p->>'notify_email')::boolean, false), coalesce((p->>'offers_ok')::boolean, false),
          v_token, p->>'idempotency_key', nullif(p->>'by_staff_id', '')::uuid,
          case when coalesce(p->>'status', 'confirmed') = 'confirmed' then now() end)
  returning id into v_id;

  insert into appointment_events (appointment_id, by_name, by_staff_id, kind, text)
  values (v_id, coalesce(p->>'by_name', 'Staff'), nullif(p->>'by_staff_id', '')::uuid, 'booked',
          coalesce(p->>'event_text', 'Booked.') || case when v_conflict is not null then ' Booked over the limit (' || v_conflict || ').' else '' end);

  perform appt_apply_messages(v_id, p->'messages');
  return jsonb_build_object('ok', true, 'id', v_id, 'number', v_number, 'token', v_token, 'rev', 1, 'over_limit', v_conflict);
end $$;

-- patch keys that may change: type_id place party starts_at ends_at status source customer_name phone_e164 email
-- functions function_date looking_for staff_notes meet_link host_staff_id notify_wa notify_email offers_ok outcome cancel_reason
create or replace function appt_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a appointments%rowtype;
  x jsonb := coalesce(p->'patch', '{}'::jsonb);
  v_type text; v_place text; v_start timestamptz; v_end timestamptz; v_host uuid; v_status text;
  v_conflict text;
  v_live boolean;
  v_capchg boolean;
  v_places text[];
begin
  select * into a from appointments where id = (p->>'id')::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p ? 'expected_rev' and a.rev <> (p->>'expected_rev')::int then
    return jsonb_build_object('ok', false, 'error', 'stale', 'rev', a.rev);
  end if;

  v_type  := coalesce(x->>'type_id', a.type_id);
  v_place := coalesce(x->>'place', a.place);
  v_start := coalesce((x->>'starts_at')::timestamptz, a.starts_at);
  v_end   := coalesce((x->>'ends_at')::timestamptz, a.ends_at);
  v_host  := case when x ? 'host_staff_id' then nullif(x->>'host_staff_id', '')::uuid else a.host_staff_id end;
  v_status := coalesce(x->>'status', a.status);
  v_live := v_status in ('requested', 'confirmed', 'arrived');
  if v_end <= v_start then return jsonb_build_object('ok', false, 'error', 'bad_time'); end if;
  select places into v_places from appointment_types where id = v_type;
  if v_places is null then return jsonb_build_object('ok', false, 'error', 'unknown_type'); end if;
  if not (v_place = any (v_places)) then return jsonb_build_object('ok', false, 'error', 'bad_place'); end if;

  -- Re-check capacity only when something that uses capacity changed, and only for a live booking.
  -- Setting, changing or clearing only the stylist uses no extra capacity: then only that stylist's diary is checked.
  v_capchg := v_start <> a.starts_at or v_end <> a.ends_at or v_place <> a.place or v_type <> a.type_id
              or a.status not in ('requested', 'confirmed', 'arrived');
  if v_live and not v_capchg and v_host is not null and v_host is distinct from a.host_staff_id then
    perform appt_lock_day(v_start);
    if exists (select 1 from appointments o where o.id <> a.id and o.status in ('requested', 'confirmed', 'arrived')
                 and o.host_staff_id = v_host and o.starts_at < v_end and v_start < o.ends_at) then
      if not coalesce((p->>'override')::boolean, false) then return jsonb_build_object('ok', false, 'error', 'host_busy'); end if;
      v_conflict := 'host_busy';
    end if;
  elsif v_live and v_capchg then
    perform appt_lock_day(least(v_start, a.starts_at));
    if (v_start at time zone 'Asia/Kolkata')::date <> (a.starts_at at time zone 'Asia/Kolkata')::date then perform appt_lock_day(greatest(v_start, a.starts_at)); end if;
    v_conflict := appt_conflict(a.id, v_type, v_start, v_end, v_place, v_host);
    if v_conflict is not null and not coalesce((p->>'override')::boolean, false) then
      return jsonb_build_object('ok', false, 'error', v_conflict);
    end if;
  end if;

  update appointments set
    type_id = v_type, place = v_place, starts_at = v_start, ends_at = v_end, host_staff_id = v_host, status = v_status,
    party         = coalesce(x->>'party', party),
    source        = coalesce(x->>'source', source),
    customer_name = coalesce(nullif(trim(x->>'customer_name'), ''), customer_name),
    phone_e164    = coalesce(x->>'phone_e164', phone_e164),
    email         = case when x ? 'email' then nullif(trim(coalesce(x->>'email', '')), '') else email end,
    functions     = case when x ? 'functions' then coalesce(array(select jsonb_array_elements_text(x->'functions')), '{}') else functions end,
    function_date = case when x ? 'function_date' then nullif(trim(coalesce(x->>'function_date', '')), '') else function_date end,
    looking_for   = case when x ? 'looking_for' then nullif(trim(coalesce(x->>'looking_for', '')), '') else looking_for end,
    staff_notes   = case when x ? 'staff_notes' then nullif(trim(coalesce(x->>'staff_notes', '')), '') else staff_notes end,
    meet_link     = case when x ? 'meet_link' then nullif(trim(coalesce(x->>'meet_link', '')), '') else meet_link end,
    notify_wa     = coalesce((x->>'notify_wa')::boolean, notify_wa),
    notify_email  = coalesce((x->>'notify_email')::boolean, notify_email),
    offers_ok     = coalesce((x->>'offers_ok')::boolean, offers_ok),
    outcome       = case when x ? 'outcome' then nullif(x->>'outcome', '') else outcome end,
    cancel_reason = case when x ? 'cancel_reason' then nullif(x->>'cancel_reason', '') else cancel_reason end,
    confirmed_at  = case when v_status = 'confirmed' and a.status = 'requested' then now() else confirmed_at end,
    cancelled_at  = case when v_status = 'cancelled' and a.status <> 'cancelled' then now() when v_status <> 'cancelled' then null else cancelled_at end,
    rev = rev + 1, updated_at = now()
  where id = a.id;

  insert into appointment_events (appointment_id, by_name, by_staff_id, kind, text)
  values (a.id, coalesce(p->>'by_name', 'Staff'), nullif(p->>'by_staff_id', '')::uuid, coalesce(p->>'event_kind', 'changed'),
          coalesce(p->>'event_text', 'Changed.') || case when v_conflict is not null then ' Over the limit (' || v_conflict || ').' else '' end);

  if p ? 'messages' then perform appt_apply_messages(a.id, p->'messages'); end if;
  return jsonb_build_object('ok', true, 'id', a.id, 'rev', a.rev + 1, 'over_limit', v_conflict);
end $$;

create or replace function appt_claim_messages(p_limit int) returns setof appointment_messages
language plpgsql security definer set search_path = public as $$
begin
  -- A send that never reported back may or may not have gone: never resend it blindly.
  update appointment_messages set state = 'uncertain', reason = 'The sender stopped mid-send', updated_at = now()
   where state = 'sending' and updated_at < now() - interval '10 minutes';
  -- Too late to be useful (e.g. a day-before reminder for a booking made 3 hours ahead).
  update appointment_messages set state = 'skipped', reason = 'Too late to send', updated_at = now()
   where state = 'scheduled' and expires_at is not null and expires_at < now();
  return query
    update appointment_messages m set state = 'sending', attempts = m.attempts + 1, updated_at = now()
     where m.id in (select id from appointment_messages where state = 'scheduled' and due_at <= now() order by due_at limit p_limit for update skip locked)
    returning m.*;
end $$;

revoke all on function appt_conflict(uuid, text, timestamptz, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function appt_apply_messages(uuid, jsonb) from public, anon, authenticated;
revoke all on function appt_lock_day(timestamptz) from public, anon, authenticated;
revoke all on function appt_book(jsonb) from public, anon, authenticated;
revoke all on function appt_update(jsonb) from public, anon, authenticated;
revoke all on function appt_claim_messages(int) from public, anon, authenticated;
grant execute on function appt_conflict(uuid, text, timestamptz, timestamptz, text, uuid) to service_role;
grant execute on function appt_apply_messages(uuid, jsonb) to service_role;
grant execute on function appt_lock_day(timestamptz) to service_role;
grant execute on function appt_book(jsonb) to service_role;
grant execute on function appt_update(jsonb) to service_role;
grant execute on function appt_claim_messages(int) to service_role;

notify pgrst, 'reload schema';
