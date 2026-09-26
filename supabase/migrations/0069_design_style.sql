-- 0069 — style classification on designs (Ansh, 26 Sep): Traditional or
-- Indo-Western, the split the buyer catalog will group by, as the storefront
-- already does through its collections. Nothing carries it yet — every design
-- starts unclassified, and it is NOT a missing-spec blocker.
--
-- Same shape as origin (0051): two machine tokens behind a CHECK; the words a
-- person sees come from STYLE_OPTIONS in src/lib/studio/copy-prompt.ts.
--
-- Reversal: alter table designs drop constraint if exists designs_style_shape;
--           alter table designs drop column if exists style;
alter table designs add column if not exists style text;
alter table designs drop constraint if exists designs_style_shape;
alter table designs add constraint designs_style_shape
  check (style is null or style in ('traditional', 'indo_western'));
