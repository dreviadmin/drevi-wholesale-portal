# Cutover log — sheet → Supabase source of truth (build guide §12.4)

ANSH-07 wants **five consecutive clean days** from `/api/dev/master-diff`
before the flip. Log one line per day. The flip itself: set
`SHEET_SYNC_ENABLED=false`, apply the cleanup migration, repoint the Python
CLI default to supabase — all prepared, none applied.

| Date | SKUs compared | Diffs | Notes |
|---|---|---|---|
| 2026-07-27 | 188 | 12 | All wholesale_price — live sheet moved after the dev snapshot; expected until team edits move into the editor. MRP diffs zeroed by seeding overrides from the sheet. |

## ⚠ Production schema drift — retrofit migrations reached prod

**What happened.** `scripts/apply-migration.mjs` loaded `.env.local`
unconditionally, and `.env.local` is **production** (`cofarxgywnrdjbizxbxw`);
dev lives in `.env.development.local` (`qvnvxcdyvcsgxulbcmzm`). So plain
`npm run db:migrate` applied retrofit migrations **0022–0027 to production**
while the retrofit was supposed to be dev-only.

**What it did to prod — checked, not assumed:**

| Migration | Prod effect |
|---|---|
| 0022 design_images | Renamed `image_candidates` (**0 rows**) → `design_images`, added columns. No data touched. |
| 0023 angles/lifestyle | Deleted closeup angles and inserted `lifestyle` across `design_angles` — which holds **0 rows** in prod. No-op. |
| 0024 receipt intake | Additive columns on `goods_receipts` / `goods_receipt_lines` (**0 rows**). |
| 0025 supply | Additive columns on `designs` (**0 rows**). |
| 0026 stock ledger | Created `stock_movements` and seeded **205 opening balances** from `wholesale_products.current_qty`. New table; nothing in prod reads it. |
| 0027 copy controls | Additive columns on `design_copy` (**0 rows**). |

**No production data was lost or altered.** The Studio/product-master tables
that these migrations reshape are all empty in prod — prod's live data is
`wholesale_products` (205), `orders` (24) and `buyers` (24), none of which any
of these migrations touch. `main` — the branch prod deploys — contains no
Studio module and never references `image_candidates`, `design_angles` or
`design_images`, so the renames cannot break the running site.

**Net state:** prod is *ahead* of its code by additive schema plus one seeded
ledger table. These same migrations have to run on prod at cutover anyway, so
they are left in place rather than reverted and re-applied.

**Root cause fixed.** `apply-migration.mjs` now defaults to **dev** and needs an
explicit `--prod` (or `DB_TARGET=prod`) to reach production, prints the target
project before doing anything, and refuses to reuse prod's `SUPABASE_DB_URL`
for a dev run.

**For Ansh to decide:** leave the drift (recommended — it is additive and
cutover needs it), or have the 205 `stock_movements` rows deleted and the table
dropped so prod returns to exactly its pre-retrofit shape.

## Dev credentials changed during R7–R9 verification (28 Jul 2026)

To drive the buyer and staff surfaces end-to-end on **dev only**
(`qvnvxcdyvcsgxulbcmzm`), two dev auth passwords were reset:

- `rivaaz.dev@drevifashion.com` → `DevBuyer!2026`
- `ansh@drevifashion.com` → `DevStaff!2026`

Production auth is untouched. Change or rotate these whenever convenient.

Dev data also carries deliberate test artefacts from this verification: order
`DX-20260717-022` is now cancelled (its stock movements went out and came back),
`DD-LEH-FLR-050-L-GRN` holds a stock-take reset of 9, and a few designs have
supply blocks set to exercise the availability states.

## 31 Aug 2026 — full cutover executed (autonomous run, Ansh away)

1. **Backup** — `.local/backups/backup-2026-08-31.json.gz` (1,172 rows + buckets).
2. **Schema** — `DB_TARGET=prod npm run db:migrate`: full 0001–0042 chain green
   (incl. 0040 unique design-image index, 0041 order_bills + lines_rev,
   0042 stock_moved backfill with replay guard).
3. **Imports** (`--prod --write`) — vendors 24 · LoVs 162 · receipts 32
   groups / 233 lines (history only, no movements) · master pricing on 192
   SKUs. 3 sheet rows skipped (no supplier — rows 96/154/198, unchanged ask).
4. **Code** — dev merged to main (`da14344`, tree identical to dev), pushed;
   prod redeployed after env so keys are baked.
5. **Env** — added to prod project: RECEIPT_INTAKE_V2, FASHN/FAL/OPENAI/
   ANTHROPIC keys, DREVI_BRAND_MODEL_FOLDER_ID, DRIVE_DESIGN_FOLDER_ID,
   COPY_MODEL=claude-opus-5.
6. **Studio scaffold** — first post-deploy sheet sync created 215 designs /
   1,290 angles; master importer re-run patched design fields on 119 designs;
   Drive ingest linked 140 wholesale_photos folders and registered 875 photos
   (idempotent re-run: 0/0). 75 designs have no Drive folder yet (photo-gap).
7. **Regression** — 12 admin routes 200; order page shows line-state chips /
   HSN / Download; dashboard has the Pending tab; fresh invoice PDF: HSN
   present, no override leak; Studio engine chips all enabled; Drive photo
   serving 200. Sheet sync healthy post-deploy (229 synced, HSN-column guard
   warning as designed). SHEET_SYNC stays ON for ~a month per the 2 Aug plan.

New with this deploy: line-level confirmation + split billing (order_bills),
past-dated billing, dashboard Pending tab — tested end-to-end on dev the same
day (see the 18 Aug commit message for the review-fix list).
