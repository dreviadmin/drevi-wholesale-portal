# Cutover log — sheet → Supabase source of truth (build guide §12.4)

ANSH-07 wants **five consecutive clean days** from `/api/dev/master-diff`
before the flip. Log one line per day. The flip itself: set
`SHEET_SYNC_ENABLED=false`, apply the cleanup migration, repoint the Python
CLI default to supabase — all prepared, none applied.

| Date | SKUs compared | Diffs | Notes |
|---|---|---|---|
| 2026-07-27 | 188 | 12 | All wholesale_price — live sheet moved after the dev snapshot; expected until team edits move into the editor. MRP diffs zeroed by seeding overrides from the sheet. |
