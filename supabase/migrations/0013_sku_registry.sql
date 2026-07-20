-- Phase 1 (SKU Generator): the SKU registry — Supabase becomes the source of
-- truth for design/variant SKUs, replacing the Apps Script SKU Generator v6.
-- During the transition the legacy Google Sheet is kept in lockstep by an
-- importer (sheet -> here) and a mirror (here -> sheet); see lib/sku.

create table if not exists public.sku_registry (
  id            uuid primary key default gen_random_uuid(),
  base_sku      text not null,              -- DD-LEH-MRM-007
  variant_sku   text not null,              -- DD-LEH-MRM-007-M-TLG
  category      text not null,              -- LEH
  sub_category  text not null,              -- MRM
  color         text not null,              -- TLG
  size          text not null,              -- M
  description   text default '',
  created_by    text not null,              -- email
  created_at    timestamptz not null default now(),
  qr_url        text,                       -- legacy Drive PNG url from sheet imports; portal rows leave null
  source        text not null default 'portal'
                 check (source in ('portal','sheet_import')),
  sheet_synced  boolean not null default false  -- true once mirrored to the Google Sheet
);

create unique index if not exists sku_registry_variant_key
  on public.sku_registry (upper(variant_sku));
create index if not exists sku_registry_catsub_idx on public.sku_registry (category, sub_category);
create index if not exists sku_registry_base_idx   on public.sku_registry (base_sku);
create index if not exists sku_registry_created_idx on public.sku_registry (created_at desc);

-- All access goes through server routes with the service-role client.
-- RLS enabled with no policies = anon and authenticated users are denied.
alter table public.sku_registry enable row level security;

-- Atomic, race-safe SKU minting. Two concurrent "New Design" generates in the
-- same CAT-SUB serialize on a transaction-scoped advisory lock and receive
-- consecutive numbers. The unique index on upper(variant_sku) is the last
-- line of defence against duplicates either way.
create or replace function public.generate_sku(
  p_mode         text,      -- 'new' | 'variant'
  p_cat          text,
  p_sub          text,
  p_base_sku     text,      -- required for 'variant'
  p_color        text,
  p_size         text,
  p_description  text,
  p_created_by   text,
  p_number_floor int default 0   -- dual-mode floor from the Google Sheet
) returns jsonb
language plpgsql security definer as $$
declare
  v_cat     text;
  v_sub     text;
  v_num     int;
  v_base    text;
  v_variant text;
  v_color   text := upper(trim(p_color));
  v_size    text := upper(trim(p_size));
  v_dup     record;
begin
  if p_mode not in ('new', 'variant') then
    raise exception 'mode must be new or variant';
  end if;
  if v_color = '' or v_size = '' then
    raise exception 'color and size are required';
  end if;

  if p_mode = 'new' then
    v_cat := upper(trim(p_cat));
    v_sub := upper(trim(p_sub));
    if v_cat = '' or v_sub = '' then
      raise exception 'category and sub-category are required';
    end if;

    -- Serialize minting per CAT-SUB.
    perform pg_advisory_xact_lock(hashtext('sku:' || v_cat || '-' || v_sub));

    select coalesce(max((substring(base_sku from '\d{3}$'))::int), 0)
      into v_num
      from public.sku_registry
     where category = v_cat and sub_category = v_sub;
    v_num := greatest(v_num, coalesce(p_number_floor, 0)) + 1;
    v_base := format('DD-%s-%s-%s', v_cat, v_sub, lpad(v_num::text, 3, '0'));
  else
    v_base := upper(trim(p_base_sku));
    if v_base !~ '^DD-[A-Z]{2,4}-[A-Z0-9]{2,4}-\d{3}$' then
      raise exception 'base SKU % is not a valid design SKU', v_base;
    end if;
    if not exists (select 1 from public.sku_registry where base_sku = v_base) then
      raise exception 'base SKU % is not in the registry — generate it as a New Design first', v_base;
    end if;
    v_cat := split_part(v_base, '-', 2);
    v_sub := split_part(v_base, '-', 3);
    v_num := (split_part(v_base, '-', 4))::int;

    -- Same lock: a concurrent new-design mint must not interleave with the
    -- duplicate check below.
    perform pg_advisory_xact_lock(hashtext('sku:' || v_cat || '-' || v_sub));
  end if;

  v_variant := v_base || '-' || v_size || '-' || v_color;

  select created_at, created_by into v_dup
    from public.sku_registry
   where upper(variant_sku) = upper(v_variant)
   limit 1;
  if found then
    raise exception 'Variant % already exists — created % by %. To add more stock of this exact variant, log a Goods Receipt instead.',
      v_variant,
      to_char(v_dup.created_at at time zone 'Asia/Kolkata', 'dd Mon yyyy, HH24:MI'),
      v_dup.created_by;
  end if;

  insert into public.sku_registry
    (base_sku, variant_sku, category, sub_category, color, size, description, created_by, source, sheet_synced)
  values
    (v_base, v_variant, v_cat, v_sub, v_color, v_size, coalesce(p_description, ''), p_created_by, 'portal', false);

  return jsonb_build_object(
    'base_sku', v_base,
    'variant_sku', v_variant,
    'num', v_num,
    'created_by', p_created_by,
    'mode', p_mode
  );
end;
$$;
