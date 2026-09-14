-- 0052 — an audit event for correcting a document's date (14 Sep 2026).
--
-- setBillDate and setOrderDate (src/app/admin/orders/actions.ts) each write a
-- mandatory audit row, but audit_event_type is a Postgres ENUM (0001_init.sql)
-- and had no value that fitted. They were writing under
-- 'document_party_recaptured' with the real meaning buried in the note text,
-- because an unlisted label is REJECTED by the database and writeAuditEvent
-- deliberately swallows its own failures — so inventing a value would have
-- silently dropped the one row that records who moved a tax document's date.
--
-- One value covers both: the note says which document and carries
-- old -> new -> reason.
--
-- Idempotent. Enum values cannot be dropped; this one is inert if unused.

alter type audit_event_type add value if not exists 'document_date_corrected';
