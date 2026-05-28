-- ============================================================================
-- Phase 3 — store the AES-256-GCM credential payload as base64 TEXT.
-- (iv | authTag | ciphertext, base64-encoded). Functionally equivalent to the
-- bytea originally specced, but avoids PostgREST bytea encoding friction. The
-- value is still decrypted only by admin-gated server routes. Idempotent.
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'buyers'
      and column_name = 'encrypted_password' and data_type = 'bytea'
  ) then
    alter table public.buyers
      alter column encrypted_password type text using encrypted_password::text;
  end if;
end $$;
