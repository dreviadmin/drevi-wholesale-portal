-- 0051 — origin becomes a two-option field (Ansh, 14 Sep: "add a field in
-- specs with dropdown: Drevi Originals / curated collection. In fact, replace
-- the value of 'origin' field with this option").
--
-- A REPLACEMENT, not a new field: designs.origin (0016) is already edited in
-- the Specs card, saved by saveSpecs, mirrored to the sheet and injected into
-- the AI copy FACTS block. Only its shape changes.
--
-- Stored values are machine tokens, 'drevi_original' and 'curated'; the words
-- "Drevi Originals" and "Curated Collection" live in
-- src/lib/studio/copy-prompt.ts, which the Specs dropdown and the prompt both
-- read. A snake_case token must never reach a model or a human-facing sheet.
-- NULL stays legal — "not set" is the honest state for a design nobody has
-- classified yet, and it is what 219 of the 221 live rows say.
--
-- DATA, checked on both databases before writing this: dev is 221/221 NULL.
-- Prod is 219 NULL plus two free-text rows, 'Drevi fashion ' and 'Drevi '
-- (trailing spaces and all), from before the field had a shape. Both mean the
-- same thing, so they are mapped to 'drevi_original' BEFORE the constraint
-- goes on — a bare ADD CONSTRAINT would fail on prod.
--
-- Reversal: alter table designs drop constraint if exists designs_origin_shape;
--
-- Idempotent: safe to re-run, and safe on either database.

-- Anything that says "Drevi" is one of ours.
update designs
set origin = 'drevi_original'
where origin is not null
  and origin not in ('drevi_original', 'curated')
  and lower(btrim(origin)) like 'drevi%';

-- Any other free text would block the constraint. There is none on either
-- database today; if a row appears later it becomes "not set" rather than
-- failing the migration — neither option can be inferred from it, and the
-- Specs card asks for the answer again.
update designs
set origin = null
where origin is not null and origin not in ('drevi_original', 'curated');

alter table designs drop constraint if exists designs_origin_shape;
alter table designs add constraint designs_origin_shape
  check (origin is null or origin in ('drevi_original', 'curated'));
