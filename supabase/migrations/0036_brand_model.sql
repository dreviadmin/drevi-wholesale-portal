-- 0036 · Productionization — per-design FASHN model choice (Ansh's plan §3).
--
-- Which brand model (Model-a / model-b / Model c subfolder) fronts this
-- design's try-ons. NULL falls back to DREVI_BRAND_MODEL (default "a").
--
-- Reversal: alter table designs drop column if exists brand_model;
-- Idempotent: safe to re-run.

alter table designs add column if not exists brand_model text;
