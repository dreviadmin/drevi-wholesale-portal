-- Stage 5 (build guide §9): audit coverage for the workbench review actions.
alter type audit_event_type add value if not exists 'studio_candidate_approved';
alter type audit_event_type add value if not exists 'studio_candidate_rejected';
