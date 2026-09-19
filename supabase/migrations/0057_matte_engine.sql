-- 0057 — the Matte composite becomes a selectable engine (Ansh, 20 Sep:
-- "also add a Matte composite option").
--
-- WHAT CHANGES
--
-- Two CHECK constraints are widened by one value each. Nothing else: no data
-- is rewritten, no default moves, no column is added.
--
--   1 design_angles.engine   gains 'matte'  (constraint from 0016, widened 0056)
--   2 pipeline_jobs.type     gains 'matte'  (constraint from 0029, widened 0056)
--
-- WHY BOTH, AND WHY BEFORE THE CODE — unchanged from 0056, and worth repeating
-- because it is the failure this pair of statements exists to prevent. The two
-- enums are the two ends of one round-trip: picking the chip writes
-- design_angles.engine, pressing Generate writes a pipeline_jobs row whose
-- `type` carries that engine to /api/pipeline/run, which maps it back. Widen
-- only the first and every Generate on a matte angle dies on the pipeline_jobs
-- constraint AFTER the operator has already chosen the engine. Widen neither
-- and the chip itself fails.
--
-- WHAT 'matte' IS, since the value says nothing on its own: it is the only
-- engine in the set that does not ask a model for a new photograph. It cuts
-- the garment out (fal-ai/birefnet/v2) and composites the SOURCE pixels onto a
-- background built locally with sharp. Database-wise that makes no difference
-- at all — it is one more legal string in two lists — but it is why the value
-- is not named after a model the way 'seedream' and 'nano_banana' are: the
-- model here is replaceable, the technique is the product.
--
-- DEFAULTS ARE NOT TOUCHED. design_angles.engine stays DEFAULT 'seedream'
-- (0053). A new angle keeps arriving on Seedream; matte is an option an
-- operator chooses per angle, which is what "add an option" means.
--
-- DATA, read off BOTH databases immediately before writing this file — a bare
-- ADD CONSTRAINT that fails on prod is the mistake 0051 documents:
--
--   dev  (qvnvxcdyvcsgxulbcmzm)  0056 IS APPLIED.
--     design_angles_engine_check
--       CHECK ((engine = ANY (ARRAY['fashn','openai_bg','raw','seedream','nano_banana'])))
--     pipeline_jobs_type_check
--       CHECK ((type = ANY (ARRAY['preprocess','vision','tryon','openai_bg',
--                                 'seedream','nano_banana','scan_drive','copy'])))
--     1186 angles: seedream 1185, openai_bg 1.
--       43 jobs: seedream 28, openai_bg 9, tryon 3, scan_drive 2, nano_banana 1.
--
--   prod (cofarxgywnrdjbizxbxw)  0056 IS APPLIED (re-read 20 Sep during review;
--     an earlier draft of this block recorded prod as pre-0056 and that is no
--     longer true — do not act on the older wording):
--     design_angles_engine_check
--       CHECK ((engine = ANY (ARRAY['fashn','openai_bg','raw','seedream','nano_banana'])))
--     pipeline_jobs_type_check
--       CHECK ((type = ANY (ARRAY['preprocess','vision','tryon','openai_bg',
--                                 'seedream','nano_banana','scan_drive','copy'])))
--     1698 angles: seedream 1695, openai_bg 3.
--       39 jobs: seedream 30, openai_bg 5, scan_drive 3, tryon 1.
--
--   EITHER STARTING STATE IS HANDLED, not worked around. Each statement below
--   drops whatever single-column CHECK is on the column and adds back the
--   COMPLETE list, so this file lands the same post-0057 definition on a
--   database sitting at 0055, at 0056, or already at 0057. That is what makes
--   it safe to run on prod without first checking which of those it is.
--
--   No 'fashn' and no 'raw' survives on either side (0053 swept them), but both
--   stay LEGAL below: keeping a value nothing uses costs nothing, and
--   re-enabling model swap (FASHN_ENABLED) should not need a migration.
--   Widening a CHECK can never fail on existing rows, so neither database has a
--   row that can block this.
--
-- CONSTRAINT NAMES ARE NOT ASSUMED. Both databases happen to carry the names
-- above, but this drops whatever single-column CHECK is actually on each
-- column — matched by conkey against the column's attnum, not by name — before
-- adding ours back. A branch or restored backup whose constraint was
-- auto-named differently would otherwise end up with two contradictory checks,
-- and the older, narrower one would win every insert.
--
-- REVERSAL (only while no row carries the new value — check first):
--   select count(*) from design_angles where engine = 'matte';
--   select count(*) from pipeline_jobs where type   = 'matte';
--   alter table design_angles drop constraint design_angles_engine_check;
--   alter table design_angles add constraint design_angles_engine_check
--     check (engine in ('fashn','openai_bg','raw','seedream','nano_banana'));
--   alter table pipeline_jobs drop constraint pipeline_jobs_type_check;
--   alter table pipeline_jobs add constraint pipeline_jobs_type_check
--     check (type in ('preprocess','vision','tryon','openai_bg','seedream','nano_banana','scan_drive','copy'));
--
-- Idempotent: safe to re-run, and safe on either database.

-- ── 1. design_angles.engine ──────────────────────────────────────────────
do $$
declare con record;
begin
  for con in
    select c.conname
      from pg_constraint c
      join pg_class rel on rel.oid = c.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_attribute att on att.attrelid = rel.oid and att.attname = 'engine'
     where ns.nspname = 'public'
       and rel.relname = 'design_angles'
       and c.contype = 'c'
       and c.conkey = array[att.attnum]   -- single-column CHECK on engine only
  loop
    execute format('alter table public.design_angles drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.design_angles
  add constraint design_angles_engine_check
  check (engine in ('fashn', 'openai_bg', 'raw', 'seedream', 'nano_banana', 'matte'));

-- ── 2. pipeline_jobs.type ────────────────────────────────────────────────
-- 'tryon' stays fashn's type name (0029's wording) — both databases still hold
-- rows on it, and renaming a stored value to tidy a table is not worth this.
do $$
declare con record;
begin
  for con in
    select c.conname
      from pg_constraint c
      join pg_class rel on rel.oid = c.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_attribute att on att.attrelid = rel.oid and att.attname = 'type'
     where ns.nspname = 'public'
       and rel.relname = 'pipeline_jobs'
       and c.contype = 'c'
       and c.conkey = array[att.attnum]   -- single-column CHECK on type only
  loop
    execute format('alter table public.pipeline_jobs drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.pipeline_jobs
  add constraint pipeline_jobs_type_check
  check (type in ('preprocess', 'vision', 'tryon', 'openai_bg', 'seedream', 'nano_banana', 'matte', 'scan_drive', 'copy'));
