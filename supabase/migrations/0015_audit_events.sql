-- Audit coverage for staff lifecycle and buyer creation (audit findings: these
-- actions previously wrote no trail).

alter type audit_event_type add value if not exists 'staff_created';
alter type audit_event_type add value if not exists 'staff_deactivated';
alter type audit_event_type add value if not exists 'staff_reactivated';
alter type audit_event_type add value if not exists 'buyer_created';
