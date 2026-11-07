-- 0078 — A design can sit in several Studio buckets.
--
-- Ansh, 7 Nov: "make the buckets option multiselect: so that the team can add
-- designs to multiple buckets at once. this will help with better control".
-- 0074 gave each design one bucket (designs.studio_bucket), so a design that
-- needed a reshoot AND new copy could only show one of the two jobs.
--
-- Membership moves to its own table, one row per (design, bucket), each with
-- who added it and when. The buckets themselves (studio_buckets) are unchanged:
-- same presets, same custom ones, same soft remove. No rows is "Not set".
--
-- designs.studio_bucket and its two stamp columns stay where they are, unread
-- and unwritten from here on, so rolling the code back still shows each
-- design's bucket as it was before this migration.
--
-- ORDER: deploy the code first, then apply this file straight away:
--   DB_TARGET=prod npm run db:migrate -- --only=0078
-- Until this file lands, the new code shows each design's old bucket and
-- refuses bucket changes with a message, so nothing is lost. The other way
-- round, the old code goes on writing designs.studio_bucket after the copy,
-- and those changes never reach design_buckets.
--
-- IF IT WAS APPLIED FIRST BY MISTAKE: once the new code is live and before
--   anyone changes a bucket on it, drop table design_buckets and apply this
--   file again. The copy then picks up the old column as the old code left it.
--
-- REVERSAL: drop table design_buckets. The old columns still hold every
--   design's bucket from before this migration (changes made since are lost).

-- Created and filled in one step, and only in the run that creates the table.
-- The runner replays every migration by default, and the old column is never
-- cleared, so a copy guarded on "the table is empty" would put back buckets
-- staff had taken off as soon as they emptied it. A DO block is one
-- transaction: the table never exists without its copy.
do $$
begin
  if to_regclass('public.design_buckets') is null then
    create table design_buckets (
      design_id  uuid not null references designs (id) on delete cascade,
      bucket_key text not null references studio_buckets (key) on update cascade on delete cascade,
      set_at     timestamptz not null default now(),
      set_by     text,
      primary key (design_id, bucket_key)
    );
    insert into design_buckets (design_id, bucket_key, set_at, set_by)
    select id, studio_bucket, coalesce(studio_bucket_set_at, now()), studio_bucket_set_by
      from designs
     where studio_bucket is not null;
  end if;
end $$;

create index if not exists design_buckets_bucket_idx on design_buckets (bucket_key);
alter table design_buckets enable row level security;

comment on table design_buckets is 'Studio buckets a design is in (0078); a design can be in several, none = Not set. A staff label only, no effect on badges, gates or publishing.';
comment on column designs.studio_bucket is 'Superseded by design_buckets (0078). Holds the bucket as it was before 0078; nothing reads or writes it now.';

notify pgrst, 'reload schema';
