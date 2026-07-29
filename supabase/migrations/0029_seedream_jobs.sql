-- 0029 · UX sprint — seedream becomes a first-class job type.
--
-- Reversal:
--   alter table pipeline_jobs drop constraint pipeline_jobs_type_check;
--   alter table pipeline_jobs add constraint pipeline_jobs_type_check
--     check (type in ('preprocess','vision','tryon','openai_bg','scan_drive','copy'));
--
-- Idempotent: drop-then-add.

alter table pipeline_jobs drop constraint if exists pipeline_jobs_type_check;
alter table pipeline_jobs add constraint pipeline_jobs_type_check
  check (type in ('preprocess','vision','tryon','openai_bg','seedream','scan_drive','copy'));
