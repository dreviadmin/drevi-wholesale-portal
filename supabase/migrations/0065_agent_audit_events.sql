-- 0065 — audit event types for agents.
--
-- Its own migration, and the values are used NOWHERE in this file. Postgres
-- refuses to use a new enum value in the same transaction that adds it, which
-- is why 0052 and 0059 exist as separate files for exactly this reason.
alter type audit_event_type add value if not exists 'agent_created';
alter type audit_event_type add value if not exists 'agent_updated';
alter type audit_event_type add value if not exists 'order_agent_set';
alter type audit_event_type add value if not exists 'agent_commission_accrued';
alter type audit_event_type add value if not exists 'agent_commission_adjusted';
alter type audit_event_type add value if not exists 'agent_payment_recorded';
alter type audit_event_type add value if not exists 'agent_payment_voided';
