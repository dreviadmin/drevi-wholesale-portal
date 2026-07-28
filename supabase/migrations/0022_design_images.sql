-- Retrofit R1 §3.1 — images become first-class.
--
-- REVERSAL: alter table design_images rename to image_candidates;
--   alter table design_angles rename column approved_image_id to approved_candidate_id;
--   drop the added columns (role, design_id, derived_from, file_name),
--   restore the old status check, drop design_angles.source_image_id.
--   design_angles.source_ref is preserved throughout, so the legacy read path
--   survives a rollback untouched.
--
-- Idempotent: every step is guarded so a re-run is a no-op.

do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'image_candidates')
     and not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'design_images')
  then
    execute 'alter table image_candidates rename to design_images';
  end if;
end $$;

alter table design_images add column if not exists role text;
alter table design_images add column if not exists design_id uuid references designs(id) on delete cascade;
alter table design_images add column if not exists derived_from uuid references design_images(id);
alter table design_images add column if not exists file_name text;
alter table design_images alter column angle_id drop not null;

-- design_id was previously reachable only through the angle
update design_images di set design_id = da.design_id
  from design_angles da where da.id = di.angle_id and di.design_id is null;

-- every existing row was a generated output
update design_images set role = 'candidate' where role is null;

-- status: ('generated','approved','rejected') -> ('active','archived','rejected')
-- approval now lives ONLY on design_angles.approved_image_id, never on the image row.
-- NOTE: the old check must be dropped BEFORE the update — the spec's ordering
-- updates first, which the surviving image_candidates_status_check rejects.
alter table design_images drop constraint if exists image_candidates_status_check;
alter table design_images drop constraint if exists design_images_status_check;
update design_images set status = 'active' where status in ('generated', 'approved');
alter table design_images add constraint design_images_status_check
  check (status in ('active', 'archived', 'rejected'));
alter table design_images drop constraint if exists design_images_role_check;
alter table design_images add constraint design_images_role_check
  check (role in ('ident', 'source', 'candidate', 'import', 'crop'));
alter table design_images alter column role set not null;

-- promote the text source_ref into real source rows.
-- `engine` was NOT NULL when every row was a generated candidate; a source /
-- ident / import / crop row has no engine, so it becomes nullable (candidates
-- still always carry one — the API sets it).
alter table design_images alter column engine drop not null;
alter table design_angles add column if not exists source_image_id uuid references design_images(id);
insert into design_images (design_id, angle_id, role, file_ref, status, created_by, created_at)
select da.design_id, da.id, 'source', da.source_ref, 'active', 'retrofit', now()
  from design_angles da
 where coalesce(da.source_ref, '') <> ''
   and not exists (select 1 from design_images d where d.angle_id = da.id and d.role = 'source');
update design_angles da set source_image_id = d.id
  from design_images d
 where d.angle_id = da.id and d.role = 'source' and da.source_image_id is null;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'design_angles' and column_name = 'approved_candidate_id')
  then
    execute 'alter table design_angles rename column approved_candidate_id to approved_image_id';
  end if;
end $$;

create index if not exists di_design_role_idx   on design_images (design_id, role);
create index if not exists di_angle_created_idx on design_images (angle_id, created_at desc);

-- RLS survives a rename, but re-assert the posture explicitly: no policies on
-- this table means anon/buyer see nothing and all access is service-role.
alter table design_images enable row level security;
