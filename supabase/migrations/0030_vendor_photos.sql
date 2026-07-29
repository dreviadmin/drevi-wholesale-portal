-- 0030 · UX sprint — richer vendor identity.
--
-- Ansh (29 Jul): a vendor record should carry the business card and the
-- contact person's photo, plus who the person actually is. Photo refs use the
-- portal-storage form "sb:vendor-photos:<path>" served by /api/drive-photo.
--
-- Reversal:
--   alter table vendors drop column if exists contact_name;
--   alter table vendors drop column if exists email;
--   alter table vendors drop column if exists card_image_ref;
--   alter table vendors drop column if exists person_image_ref;
--
-- Idempotent: safe to re-run.

alter table vendors add column if not exists contact_name text;
alter table vendors add column if not exists email text;
alter table vendors add column if not exists card_image_ref text;
alter table vendors add column if not exists person_image_ref text;
