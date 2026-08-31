-- 0031 · UX sprint — richer order lifecycle + tracking details.
--
-- Ansh (29 Jul): orders need stages beyond confirmed/fulfilled, and
-- out-for-delivery must carry tracking details + a tracking-sheet photo.
--
--   submitted → confirmed → packed → out_for_delivery → delivered
--                     ↘ cancelled (stock returns if it had left)
--
-- 'fulfilled' stays as a legacy terminal state on old rows; new flows end at
-- 'delivered'. Stock still leaves ONLY on confirm (§10.1) — later stages are
-- logistics, not inventory.
--
-- Reversal (columns only — enum values cannot be dropped in Postgres):
--   alter table orders drop column if exists courier;
--   alter table orders drop column if exists tracking_number;
--   alter table orders drop column if exists tracking_note;
--   alter table orders drop column if exists tracking_image_ref;
--   alter table orders drop column if exists packed_at;
--   alter table orders drop column if exists out_for_delivery_at;
--   alter table orders drop column if exists delivered_at;
--
-- Idempotent: safe to re-run.

alter type order_status add value if not exists 'packed';
alter type order_status add value if not exists 'out_for_delivery';
alter type order_status add value if not exists 'delivered';

alter table orders add column if not exists courier text;
alter table orders add column if not exists tracking_number text;
alter table orders add column if not exists tracking_note text;
-- "sb:order-attachments:<path>", served by /api/drive-photo
alter table orders add column if not exists tracking_image_ref text;
alter table orders add column if not exists packed_at timestamptz;
alter table orders add column if not exists out_for_delivery_at timestamptz;
alter table orders add column if not exists delivered_at timestamptz;
