# Cutover runbook — dev portal → production

Agreed plan (2 Aug 2026): portal becomes master, SHEET_SYNC stays on ~1 month,
ex-GST costing, per-SKU pricing preserved. No blackout window required, but
run steps 2–6 in one sitting.

## 0 · Prerequisites (Ansh)
- [ ] `wholesale_photos` Shared-Drive folder: BASE-COLOR subfolders, shared to
      `drevi-pipeline-sa@drevi-pipeline.iam.gserviceaccount.com` (Content Manager)
- [ ] FASHN credits topped up
- [ ] Dev-site pass on phone + laptop (§12 checklist below)

## 1 · Photos (as soon as the folder id exists — independent of the rest)
```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && npm run retrofit:folder-audit
```
Resolve any ambiguous folders it reports, then dry-run and migrate:
```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && node scripts/migrate-photos-to-drive.mjs
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && node scripts/migrate-photos-to-drive.mjs --write
```

## 2 · Backup, then prod schema
```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && npm run db:backup
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && DB_TARGET=prod npm run db:migrate
```
(Applies 0028–0038 to prod — all additive; 0022–0027 and 0034/0035 are already there.)

## 3 · Data imports into prod (dry-run first, then write)
```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && node scripts/import-sheet-data.mjs all --prod
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && node scripts/import-sheet-data.mjs all --prod --write
```
Rehearsed on dev: vendors 25 · LoVs 162 · receipts 30 (history only, NO stock
movements) · pricing on 169 SKUs · spec fields + copy drafts on ~120 designs.

## 4 · Code: merge dev → main (deploys prod automatically)
```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && git checkout main && git pull && git merge dev && git push origin main && git checkout dev
```
Conflicts expected ONLY in files cherry-picked to main earlier (order-pdf,
OrderActions, sync, types) — take the dev side everywhere.

## 5 · Prod Vercel env (then one more deploy — env is baked at build time)
Add: `RECEIPT_INTAKE_V2=true`, `FASHN_API_KEY`, `FAL_KEY`, `OPENAI_API_KEY`,
`DREVI_BRAND_MODEL_FOLDER_ID`, `DRIVE_DESIGN_FOLDER_ID` (from step 1).
Values live in `.env.development.local` / `.env.local`.

## 6 · Verify prod (§12 regression floor)
- Buyer: login → home → catalog → product → cart → submit
- Staff: orders (bulk bar, HSN, download/refresh), log delivery incl. GST,
  stock count tabs, studio (generate one Seedream candidate), vendors, lists
- One invoice PDF: HSN present, no "was" price
- `/api/admin/stock-reconcile` reads zero drift after a stock take of a rack

## 7 · Month-later (sheet retirement)
- Flip `SHEET_SYNC_ENABLED=false`, remove the §3.7 guard in sync.ts,
  and decide the export-to-sheet cadence if the sheet stays as reference.

## Rollback
Prod deploys are immutable — "Instant Rollback" in Vercel picks the previous
deployment. DB: migrations are additive (nothing dropped), imports are
idempotent with tagged refs (`GR-IMP-*`, sheet-import client_refs) so they can
be deleted wholesale if ever needed. Step-2 backup is the belt and braces.
