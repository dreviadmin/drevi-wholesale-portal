-- 0027 · Retrofit R6 (spec v1.3 §8) — vision controls on the copy track.
--
-- The copy panel gets an editable prompt, persisted per design, and a model
-- override. Angle prompts are authored in Studio (§7), so vision's job here is
-- name, description and tags only.
--
-- Reversal:
--   alter table design_copy drop column if exists prompt;
--   alter table design_copy drop column if exists prompt_edited_by;
--   alter table design_copy drop column if exists model_override;
--
-- Idempotent: safe to re-run.

alter table design_copy add column if not exists prompt text;
alter table design_copy add column if not exists prompt_edited_by text;
alter table design_copy add column if not exists model_override text;

comment on column design_copy.prompt is
  'Operator-edited vision prompt. NULL means "use the default built from this design''s specs" — so a spec correction flows through until someone overrides it.';
comment on column design_copy.model_override is
  'Explicit model choice for this design. NULL falls back to the tier default (§8): hero -> COPY_MODEL_HERO, else COPY_MODEL.';
