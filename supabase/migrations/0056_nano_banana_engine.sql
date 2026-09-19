-- 0056 — Nano Banana 2 becomes a selectable engine (Ansh, 20 Sep, after a
-- 38-render bench: "Change the current seed dream option to use v5 Pro, and
-- also add a nano banana option").
--
-- WHAT CHANGES
--
-- Two CHECK constraints are widened by one value each. Nothing else: no data
-- is rewritten, no default moves, no column is added.
--
--   1 design_angles.engine   gains 'nano_banana'  (constraint from 0016)
--   2 pipeline_jobs.type     gains 'nano_banana'  (constraint from 0029)
--
-- WHY BOTH, AND WHY BEFORE THE CODE
--
-- The two enums are the two ends of one round-trip. Picking the chip writes
-- design_angles.engine; pressing Generate writes a pipeline_jobs row whose
-- `type` carries that engine to /api/pipeline/run, which maps it back. Widen
-- only the first and every Generate on a nano_banana angle dies on the
-- pipeline_jobs constraint AFTER the operator has already chosen the engine.
-- Widen neither and the chip itself fails. So both, and both before the deploy
-- — the code that writes these values is in the same change.
--
-- The v5 Pro half of the owner's request needs NO migration: 'seedream' is
-- still the stored value, it just points at a different fal endpoint now
-- (src/lib/pipeline/engines.ts). That is deliberate — re-pointing what
-- 'seedream' means was the ask; re-pointing every existing angle was not.
--
-- DEFAULTS ARE NOT TOUCHED. design_angles.engine stays DEFAULT 'seedream'
-- (set by 0053). A new angle keeps arriving on Seedream; Nano Banana is an
-- option an operator chooses per angle, which is what "add an option" means.
--
-- DATA, read off BOTH databases immediately before writing this file — a bare
-- ADD CONSTRAINT that fails on prod is the exact mistake 0051 documents. Both
-- carried byte-identical constraint definitions:
--
--   design_angles_engine_check
--     CHECK ((engine = ANY (ARRAY['fashn'::text, 'openai_bg'::text,
--                                 'raw'::text, 'seedream'::text])))
--   pipeline_jobs_type_check
--     CHECK ((type = ANY (ARRAY['preprocess'::text, 'vision'::text,
--                               'tryon'::text, 'openai_bg'::text,
--                               'seedream'::text, 'scan_drive'::text,
--                               'copy'::text])))
--
--   dev  (qvnvxcdyvcsgxulbcmzm)  1186 angles: seedream 1185, openai_bg 1.
--                                  42 jobs:   seedream 28, openai_bg 9,
--                                             tryon 3, scan_drive 2.
--   prod (cofarxgywnrdjbizxbxw)  1698 angles: seedream 1695, openai_bg 3.
--                                  39 jobs:   seedream 30, openai_bg 5,
--                                             scan_drive 3, tryon 1.
--
--   No 'fashn' and no 'raw' survives on either side (0053 swept them), but
--   both stay LEGAL below: keeping a value nothing uses costs nothing, and
--   re-enabling model swap (FASHN_ENABLED) should not need a migration.
--   Widening a CHECK can never fail on existing rows, so neither database has
--   a row that can block this.
--
-- CONSTRAINT NAMES ARE NOT ASSUMED. Both databases happen to carry the
-- names above, but this drops whatever single-column CHECK is actually on
-- each column — matched by conkey, not by name — before adding ours back. A
-- branch or restored backup whose constraint was auto-named differently would
-- otherwise end up with two contradictory checks, and the older, narrower one
-- would win every insert.
--
-- REVERSAL (only while no row carries the new value — check first):
--   select count(*) from design_angles where engine = 'nano_banana';
--   select count(*) from pipeline_jobs where type   = 'nano_banana';
--   alter table design_angles drop constraint design_angles_engine_check;
--   alter table design_angles add constraint design_angles_engine_check
--     check (engine in ('fashn','openai_bg','raw','seedream'));
--   alter table pipeline_jobs drop constraint pipeline_jobs_type_check;
--   alter table pipeline_jobs add constraint pipeline_jobs_type_check
--     check (type in ('preprocess','vision','tryon','openai_bg','seedream','scan_drive','copy'));
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
  check (engine in ('fashn', 'openai_bg', 'raw', 'seedream', 'nano_banana'));

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
  check (type in ('preprocess', 'vision', 'tryon', 'openai_bg', 'seedream', 'nano_banana', 'scan_drive', 'copy'));
