-- ============================================================================
-- Exhibition-pro pass: in-store source, tax + payment on orders, buyer card
-- image, session type. Idempotent.
-- ============================================================================

-- In-store is a first-class order source (own prefix + reporting).
alter type order_source add value if not exists 'in_store';

-- Buyer visiting-card / photo (storage path in the 'buyer-cards' bucket;
-- signed URL generated on read).
alter table public.buyers add column if not exists card_image_path text;

-- Tax + payment recorded at staff-assisted finalise.
-- tax_mode: none | inclusive | exclusive (validated in app code).
alter table public.orders
  add column if not exists tax_mode text not null default 'none',
  add column if not exists tax_rate numeric(5,2),
  add column if not exists tax_amount numeric(12,2) not null default 0,
  add column if not exists advance_amount numeric(12,2) not null default 0,
  add column if not exists payment_method text,
  add column if not exists payment_notes text;

-- Session type drives the order source + number prefix (DX- vs IS-).
alter table public.exhibition_sessions
  add column if not exists session_type text not null default 'exhibition';
