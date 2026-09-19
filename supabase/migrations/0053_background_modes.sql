-- 0053 — three background modes, and two engines retired (Ansh, 19 Sep:
-- "Disable fashn and RAW for now: they are of no use currently. For OpenAI and
-- seed dream, there shall be these options visible: Minimal - White bg
-- (recommended) / Studio grey / Coloured background").
--
-- WHAT CHANGES
--
-- 1 designs.bg_style stops meaning "which prose preset describes the backdrop"
--   and starts meaning "which of three MODES this design uses":
--       'minimal'                        white, prompt only, no plate
--       'grey'                           the 3-Sep studio grey, prompt only
--       'auto' + ivory/sand/stone/       coloured — a backdrop PLATE IMAGE is
--       blush/midnight                   sent alongside the garment photo
--   Eight legal values, listed in src/lib/studio/backgrounds.ts and mirrored
--   by the CHECK below. The five colours are Kalki-derived plates that live in
--   the public `product-images` bucket under _backgrounds/ (uploaded by
--   scripts/upload-backgrounds.mjs); the database only ever stores the key.
--
--   The old prose presets go away because words were the failure: the same
--   sentence produced a different wall on every render. 'champagne' and
--   'taupe' both described a warm beige backdrop, so both land on 'sand';
--   'charcoal' was the dark option, so it lands on 'midnight'.
--
-- 2 designs.bg_style DEFAULT moves from 'auto' to 'minimal', and EVERY row
--   currently on 'auto' moves with it. THIS IS A DELIBERATE BEHAVIOUR CHANGE
--   the owner asked for — "Minimal — White bg (recommended)".
--
--   Sweeping 'auto' in is the part worth arguing about, so: 'auto' has been
--   the column DEFAULT since 0045, which means all 276 prod / 221 dev rows
--   holding it are rows nobody ever expressed an opinion about. Under the new
--   shape 'auto' means "coloured, pick one for me" — a mode that needs a plate
--   image and did not exist when those rows were written. Leaving them there
--   would opt the entire catalogue into coloured backdrops by accident, on the
--   strength of an old default. Three consequences follow:
--     · the plate must exist in storage on that project or every Generate
--       fails, which made a missing upload a catalogue-wide outage;
--     · the auto pool changed from 4 prose presets to 5 plates, so hash % n
--       lands elsewhere and a design's already-approved angles would no longer
--       match a newly regenerated one;
--     · nobody chose it.
--   'auto' stays a legal, offered value — it is one of the six coloured
--   options — it is just opt-in from here, not inherited.
--
-- 3 design_angles.engine DEFAULT moves from 'fashn' to 'seedream', and every
--   row on 'fashn' or 'raw' is remapped to 'seedream'. The CHECK is left
--   ALONE: all four values ('fashn','openai_bg','raw','seedream') stay legal,
--   so nothing already stored anywhere becomes invalid and re-enabling model
--   swap later (FASHN_ENABLED) needs no migration.
--
--   PUBLISHING IS UNAFFECTED by the 'raw' remap. Publish has always used
--   (approved candidate ?? source) regardless of engine — 'raw' was never a
--   publishing mode, only a "do not offer a Generate button on this angle"
--   flag. A remapped angle publishes exactly the image it published before;
--   the only difference is that Generate is now offered on it.
--
-- DATA, checked on BOTH databases before writing this mapping (a bare ADD
-- CONSTRAINT that fails on prod is the exact mistake 0051 documents):
--
--   dev  (qvnvxcdyvcsgxulbcmzm)  221 designs: auto 221.
--                                1186 angles: fashn 1154, seedream 20,
--                                raw 11, openai_bg 1.
--   prod (cofarxgywnrdjbizxbxw)  279 designs: auto 276, champagne 1,
--                                ivory 1, charcoal 1.
--                                1674 angles: fashn 1111, raw 555, seedream 8.
--
--   No NULL and no 'taupe' on either database (bg_style has been NOT NULL
--   DEFAULT 'auto' since 0045), but both are mapped anyway so this is safe on
--   a restored backup or a branch database that predates that default.
--
-- REVERSAL:
--   alter table designs drop constraint if exists designs_bg_style_shape;
--   alter table designs alter column bg_style set default 'auto';
--   alter table design_angles alter column engine set default 'fashn';
--   The remapped VALUES are not reversible — 'champagne' vs 'taupe' and
--   'fashn' vs 'raw' are not recoverable once merged. Take a backup first if
--   that distinction still matters to anyone (npm run db:backup).
--
-- Idempotent: safe to re-run, and safe on either database.

-- ── 1. bg_style → the eight modes ────────────────────────────────────────
-- Retired prose presets, mapped to the plate nearest what they described.
update designs set bg_style = 'sand'     where bg_style in ('champagne', 'taupe');
update designs set bg_style = 'midnight' where bg_style = 'charcoal';

-- Unset, unreadable, or the inherited 'auto' default all become the
-- recommended white (see note 2 above). Any value outside the eight lands here
-- too rather than failing the constraint: none exists today, and "recommended
-- white" is the honest answer for a row whose intent cannot be read.
update designs
set bg_style = 'minimal'
where bg_style is null
   or btrim(bg_style) = ''
   or bg_style = 'auto'
   or bg_style not in ('minimal', 'grey', 'auto', 'ivory', 'sand', 'stone', 'blush', 'midnight');

alter table designs alter column bg_style set default 'minimal';

alter table designs drop constraint if exists designs_bg_style_shape;
alter table designs add constraint designs_bg_style_shape
  check (bg_style in ('minimal', 'grey', 'auto', 'ivory', 'sand', 'stone', 'blush', 'midnight'));

-- ── 2. engine → seedream ─────────────────────────────────────────────────
-- updated_at is deliberately NOT touched: this is a platform decision, not an
-- edit anyone made to these angles, and the Workbench shows that column.
update design_angles set engine = 'seedream' where engine in ('fashn', 'raw');

alter table design_angles alter column engine set default 'seedream';
