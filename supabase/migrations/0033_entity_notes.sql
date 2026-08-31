-- 0033 · Ansh (30 Jul): every entity — vendor, order, customer, design,
-- receipt — carries additional notes WITH photos, for details we might forget.
--
-- One polymorphic log instead of a column per table: an entity accumulates
-- timestamped notes, each with its author and up to a few photos
-- ("sb:note-photos:<path>" refs served by /api/drive-photo). Never overwritten,
-- so nothing is forgotten by editing.
--
-- Reversal:
--   drop table if exists entity_notes;
--   delete from storage.objects where bucket_id = 'note-photos';
--   delete from storage.buckets where id = 'note-photos';
--
-- Idempotent: safe to re-run.

create table if not exists entity_notes (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('vendor','order','buyer','design','receipt','product','session')),
  entity_id text not null, -- uuid for most entities; SKU for product
  note text not null default '',
  photo_refs text[] not null default '{}',
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists entity_notes_entity_idx on entity_notes (entity_type, entity_id, created_at desc);

-- Internal table: RLS on, no policies — service-role access only (house posture).
alter table entity_notes enable row level security;

insert into storage.buckets (id, name, public)
values ('note-photos', 'note-photos', false)
on conflict (id) do nothing;
