-- Stage 7 (build guide §11.1, guide file 0017 → repo 0019 per DECISIONS):
-- canonical registry of PUBLISHED images per design angle. The public
-- `product-images` bucket itself is provisioned on demand by ensureBucket,
-- exactly how product-photos was.

create table if not exists product_images (
  sku_base text not null,
  color text not null,
  angle text not null,
  storage_path text not null,
  source_candidate_id uuid,
  published_at timestamptz,
  primary key (sku_base, color, angle)
);

alter table product_images enable row level security;

alter type audit_event_type add value if not exists 'studio_published';
