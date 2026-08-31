-- Stage 4 (build guide §8.1, guide file 0016 → repo 0017 per DECISIONS):
-- pipeline job queue. The runner (GitHub Actions or local CLI) claims a row,
-- streams progress/log/cost back, and finishes done|error. Idempotent.

create table if not exists pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('preprocess','vision','tryon','openai_bg','scan_drive','copy')),
  design_id uuid references designs(id), angle_id uuid references design_angles(id),
  params jsonb default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','claimed','running','done','error','cancelled')),
  progress int not null default 0, log text default '', cost_credits numeric default 0,
  requested_by text, runner_id text,
  created_at timestamptz default now(), started_at timestamptz, finished_at timestamptz
);
create index if not exists pj_status_idx on pipeline_jobs(status, created_at);

alter table pipeline_jobs enable row level security;

-- Realtime job chips: ACTIVE STAFF may read job rows (buyers/anon never —
-- ops invariant: nothing operational leaks to buyers). Writes stay
-- service-role only (no insert/update policies).
do $$ begin
  create policy pipeline_jobs_staff_read on pipeline_jobs
    for select to authenticated
    using (exists (select 1 from staff_users s where s.id = auth.uid() and s.active));
exception when duplicate_object then null; end $$;

-- Enable Realtime (publication add is not idempotent by itself).
do $$ begin
  alter publication supabase_realtime add table pipeline_jobs;
exception when duplicate_object then null; end $$;
