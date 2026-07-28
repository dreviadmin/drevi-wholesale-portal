-- Retrofit R1 §3.2 — closeup becomes lifestyle (NOT a rename: a closeup is not
-- a lifestyle shot). Existing closeup images survive as design-level images,
-- selectable for any angle in the new picker.
--
-- REVERSAL: re-add 'closeup' to the check constraint, insert closeup angle rows
--   per design, and re-attach detached images by matching design_id — note the
--   original angle_id values are NOT recoverable, which is why the images are
--   deliberately detached rather than deleted.

alter table design_angles drop constraint if exists design_angles_angle_check;
alter table design_angles add constraint design_angles_angle_check
  check (angle in ('front', 'back', 'side', 'lifestyle', 'closeup', 'detail_1', 'detail_2'));

-- detach images from closeup angles; they survive as design-level images
update design_images set angle_id = null
 where angle_id in (select id from design_angles where angle = 'closeup');

-- an angle row about to vanish must not be referenced
update design_angles set approved_image_id = null, source_image_id = null where angle = 'closeup';

delete from design_angles where angle = 'closeup';

insert into design_angles (design_id, angle)
select id, 'lifestyle' from designs
on conflict (design_id, angle) do nothing;

alter table design_angles drop constraint design_angles_angle_check;
alter table design_angles add constraint design_angles_angle_check
  check (angle in ('front', 'back', 'side', 'lifestyle', 'detail_1', 'detail_2'));
