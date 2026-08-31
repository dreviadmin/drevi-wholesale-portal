-- Stage 3 (build guide §7.1, guide file 0015 → repo 0016 per DECISIONS):
-- Studio data model — one design record per (base_sku, color), independent
-- photo/copy tracks, per-portal publish targets. Idempotent.

create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  base_sku text not null, color text not null,          -- group key
  title text, category text, sub_category text,
  tier text not null default 'standard' check (tier in ('standard','hero')),
  fabric text, handwork text, origin text,              -- spec mirror (sheet-owned until Stage 8)
  specs_verified boolean not null default false,        -- Rakesh confirmation flag
  drive_input_id text, drive_processed_id text, drive_tryon_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (base_sku, color)
);

create table if not exists design_angles (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references designs(id) on delete cascade,
  angle text not null check (angle in ('front','back','side','closeup','detail_1','detail_2')),
  source_ref text,                                       -- drive file id of mannequin/macro source
  prompt text default '', prompt_edited_by_human boolean not null default false,
  engine text not null default 'fashn' check (engine in ('fashn','openai_bg','raw','seedream')),
  approved_candidate_id uuid,                            -- FK added after image_candidates
  updated_at timestamptz default now(),
  unique (design_id, angle)
);

create table if not exists image_candidates (
  id uuid primary key default gen_random_uuid(),
  angle_id uuid not null references design_angles(id) on delete cascade,
  engine text not null, params jsonb default '{}'::jsonb,
  file_ref text not null,                                -- drive id or storage path
  status text not null default 'generated' check (status in ('generated','approved','rejected')),
  cost_credits numeric default 0, job_id uuid, created_by text, created_at timestamptz default now()
);

do $$ begin
  alter table design_angles add constraint da_approved_fk
    foreign key (approved_candidate_id) references image_candidates(id) deferrable;
exception when duplicate_object then null; end $$;

create table if not exists design_copy (
  design_id uuid primary key references designs(id) on delete cascade,
  title text, description text, tags jsonb default '[]'::jsonb,
  status text not null default 'none' check (status in ('none','draft','approved')),
  model text, generated_at timestamptz, edited_by text, approved_by text, approved_at timestamptz
);

create table if not exists publish_targets (
  design_id uuid not null references designs(id) on delete cascade,
  portal text not null check (portal in ('wholesale','shopify')),
  enabled boolean not null default true,
  state text not null default 'not_ready' check (state in
    ('not_ready','ready','pushing','live','changes_pending','error')),
  last_pushed_at timestamptz, remote_id text, error text,
  primary key (design_id, portal)
);

create index if not exists designs_base_sku_idx on designs(base_sku);
create index if not exists image_candidates_angle_idx on image_candidates(angle_id, created_at desc);
create index if not exists publish_targets_state_idx on publish_targets(state);

-- Batch actions must leave a trail (guide §7.4 done-when).
alter type audit_event_type add value if not exists 'studio_tier_set';
alter type audit_event_type add value if not exists 'studio_portal_toggled';

-- Same posture as every other internal table: RLS on, no policies — anon and
-- buyer roles see nothing; all access flows through the service role. The D5
-- rule (detail angles never get AI engines) is enforced in the API layer.
alter table designs enable row level security;
alter table design_angles enable row level security;
alter table image_candidates enable row level security;
alter table design_copy enable row level security;
alter table publish_targets enable row level security;
