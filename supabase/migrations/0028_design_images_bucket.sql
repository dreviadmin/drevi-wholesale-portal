-- 0028 · UX sprint — private storage bucket for design photos.
--
-- Photo capture must work TODAY (Ansh, 29 Jul): while DRIVE_DESIGN_FOLDER_ID
-- stays unset (ANSH-19), studio/ident/vendor uploads land in the portal's own
-- Supabase storage instead of being disabled. This is NOT the forbidden
-- fallback to the legacy Drive INPUT folder — it is the app's own bucket, and
-- once the Drive folder id arrives, new uploads switch to Drive while sb:*
-- refs here keep serving.
--
-- Reversal:
--   delete from storage.objects where bucket_id in ('design-images','vendor-photos','order-attachments');
--   delete from storage.buckets where id in ('design-images','vendor-photos','order-attachments');
--
-- Idempotent: safe to re-run.

insert into storage.buckets (id, name, public)
values
  ('design-images', 'design-images', false),
  ('vendor-photos', 'vendor-photos', false),
  ('order-attachments', 'order-attachments', false)
on conflict (id) do nothing;
