-- 0040 — one row per (design_id, file_ref).
--
-- The Drive ingest (4 Aug) registers folder files as design_images rows, and
-- review found two ways duplicates slip in: a check-then-insert race between
-- Sync Drive and a portal upload, and the batch script re-running against a
-- truncated dedupe read. A unique index closes every path at the database, and
-- lets both writers use ON CONFLICT DO NOTHING semantics.
--
-- Dedupe first (dev carries two retrofit-era pairs): within each duplicate
-- group keep the row something points at — an angle's source/approved image or
-- a design's ident — and otherwise the oldest. A row that is referenced is
-- never the one deleted; if BOTH rows of a pair were referenced the delete
-- keeps them all and the index build fails loudly rather than silently
-- rewiring history (none exist today; resolve by hand if one ever appears).

with ranked as (
  select di.id,
         row_number() over (
           partition by di.design_id, di.file_ref
           order by
             (exists (select 1 from design_angles a
                       where a.source_image_id = di.id or a.approved_image_id = di.id)) desc,
             (exists (select 1 from designs d where d.ident_image_id = di.id)) desc,
             di.created_at asc,
             di.id asc
         ) as rn
  from design_images di
)
delete from design_images
 where id in (select id from ranked where rn > 1)
   and id not in (select source_image_id  from design_angles where source_image_id  is not null)
   and id not in (select approved_image_id from design_angles where approved_image_id is not null)
   and id not in (select ident_image_id   from designs       where ident_image_id   is not null);

create unique index if not exists di_design_file_ref_unique
  on design_images (design_id, file_ref);
