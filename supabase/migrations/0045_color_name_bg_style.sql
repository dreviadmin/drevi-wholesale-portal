-- 0045 — spec colour name + per-design background style (Ansh, 3 Sep).
--
-- color_name: the human colour ("Champagne Gold") beside the SKU code (CHG) —
-- staff record it in Specs; the copy generator and angle prompts consume it.
--
-- bg_style: which studio background this design's AI images use. 'auto' picks
-- deterministically from the design itself (same choice for every angle and
-- every regeneration — the determinism Ansh asked about), the rest pin an
-- explicit look. Presets live in code (src/lib/studio/backgrounds.ts).

alter table designs add column if not exists color_name text;
alter table designs add column if not exists bg_style text not null default 'auto';
