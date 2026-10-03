-- 0074 — Studio buckets: staff sort designs into work queues.
--
-- Ansh, 3 Oct: "staff can classify the designs in the studio into buckets: a
-- dropdown containing Needs Shoot, Needs Reshoot, Copy regeneration needed,
-- Verified - all good, and an option to add a custom state — that actually
-- works. Once a custom option is added it starts showing in the dropdown
-- immediately. Also add option to filter by this field — also including an
-- option for not set."
--
-- A human label, not derived state: nothing here feeds deriveBadge, the
-- publish gates or Shopify. One bucket per design; NULL is "Not set".
--
-- The options are a table rather than a CHECK list (cf. 0069 style) because
-- staff add to it from the dropdown. Presets are seeded rows flagged preset so
-- the UI can refuse to remove them. Removing a custom bucket hides it from the
-- dropdown (active = false) — designs already in it keep it, and adding the
-- same name again brings it back. The case-insensitive label index is what
-- makes "needs shoot" and "Needs Shoot" one bucket.
--
-- REVERSAL: alter table designs drop column studio_bucket,
--   drop column studio_bucket_set_at, drop column studio_bucket_set_by;
--   drop table studio_buckets;

create table if not exists studio_buckets (
  key        text primary key,
  label      text not null,
  sort       int not null default 100,
  preset     boolean not null default false,
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  constraint studio_buckets_key_shape check (key ~ '^[a-z0-9_]{1,48}$'),
  constraint studio_buckets_label_len check (char_length(btrim(label)) between 1 and 40)
);
create unique index if not exists studio_buckets_label_key on studio_buckets (lower(btrim(label)));
alter table studio_buckets enable row level security;

insert into studio_buckets (key, label, sort, preset) values
  ('needs_shoot',   'Needs Shoot',              10, true),
  ('needs_reshoot', 'Needs Reshoot',            20, true),
  ('copy_regen',    'Copy regeneration needed', 30, true),
  ('verified',      'Verified - all good',      40, true)
on conflict (key) do nothing;

alter table designs add column if not exists studio_bucket text
  references studio_buckets (key) on update cascade on delete set null;
alter table designs add column if not exists studio_bucket_set_at timestamptz;
alter table designs add column if not exists studio_bucket_set_by text;
create index if not exists designs_studio_bucket_idx on designs (studio_bucket);

comment on table studio_buckets is 'Studio work-queue labels (0074). Presets seeded; staff add custom ones from the dropdown; active=false hides one from the dropdown.';
comment on column designs.studio_bucket is 'Studio bucket key (studio_buckets.key); NULL = Not set. A staff label only — no effect on badges, gates or publishing.';
comment on column designs.studio_bucket_set_by is 'Name (or email) of the staff member who last set the bucket.';
