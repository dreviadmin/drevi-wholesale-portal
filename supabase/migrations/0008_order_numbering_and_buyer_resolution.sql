-- 0008 — two correctness fixes surfaced by the July 2026 audit.
--
-- (A) Atomic order numbering. The app previously did count(*)+attempt in a
--     retry loop, which skipped numbers under concurrency and then paid a
--     guaranteed-collision "tax" for the rest of the day. Gaps in a GST invoice
--     series are an audit liability. This counter table + function reserve each
--     number atomically (INSERT .. ON CONFLICT DO UPDATE row-locks per
--     prefix+day), so concurrent staff get distinct, gapless numbers.
--
-- (B) Deterministic buyer identity. 0007 dropped the unique email index, so a
--     duplicate row (walk-in captured under an existing buyer's email, or an
--     inquiry-form submission) made current_buyer_id()'s `limit 1` pick an
--     arbitrary row — potentially binding a real buyer's cart/orders RLS to the
--     wrong record. Only one row per email may hold credentials (enforced in
--     setCredentials), so we resolve to the credentialed row deterministically.

-- ---------------------------------------------------------------------------
-- (A) Order-number counter
-- ---------------------------------------------------------------------------
create table if not exists public.order_counters (
  prefix text not null,
  day    text not null,           -- YYYYMMDD
  seq    int  not null default 0,
  primary key (prefix, day)
);

create or replace function public.next_order_number(p_prefix text, p_day text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq int;
begin
  -- First call for a prefix+day seeds from any pre-existing orders (so we never
  -- reissue a number); every later call just increments the counter atomically.
  insert into public.order_counters (prefix, day, seq)
  values (
    p_prefix,
    p_day,
    greatest(
      1,
      coalesce(
        (select max((split_part(order_number, '-', 3))::int)
           from public.orders
          where order_number like p_prefix || '-' || p_day || '-%'),
        0
      ) + 1
    )
  )
  on conflict (prefix, day)
  do update set seq = public.order_counters.seq + 1
  returning seq into v_seq;

  return p_prefix || '-' || p_day || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- (B) Deterministic logged-in buyer resolution
-- ---------------------------------------------------------------------------
create or replace function public.current_buyer_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from public.buyers
   where email = public.jwt_email()
   -- credentialed row wins (only one may exist per email); tie-break by age.
   order by (encrypted_password is not null) desc, created_at asc
   limit 1
$$;
