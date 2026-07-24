# Phase 1 — build decisions & deviations

One line per deviation from the spec, with rationale, as required by §0.

1. **Reference files absent** — `docs/reference/sku-generator/Code.gs` and
   `Index-v6.html` were not in the repo at build time (operator step §12.1
   pending); the label math, `kf`/vendor-code formulas, color-ranking and
   layout metrics were built from the spec's §5/§6 numbers, which are complete.
2. **Registry sheet access pending** — the service account returned "caller
   does not have permission" on the SKU registry sheet (operator step §12.2:
   grant Editor). Importer/mirror/floor are built and fail soft; the first
   successful cron after access is granted performs the historical backfill.
   Until then `SKU_DUAL_MODE` floor reads return 0 with a warning (spec'd
   behaviour) — minting proceeds on registry-only numbering.
3. **Cron endpoint accepts GET as well as POST** — the workflow uses POST per
   spec; GET kept for parity with how the other cron endpoints are invoked
   manually (`curl -H "Authorization: …"`).
4. **`jspdf` + `qrcode` added as dependencies** — the reference tool's roll-PDF
   is jsPDF-based (mm units, `[w,h]` page boxes); porting to the existing
   server-side `@react-pdf/renderer` would change the calibrated output. Both
   libraries are client-side only (print tray runs in the browser), no server
   surface.
5. **Audit rows reuse `auth_audit_log`** — vendor/receipt events write to the
   existing audit table with new enum values (migration 0014) rather than a
   new table, matching how catalog_edit was added in 0010.
6. **Product-table floor added to minting** — until the registry backfill runs (sheet access pending), the empty registry would mint numbers that collide with legacy SKUs already live in `wholesale_products`/`product_vendor_info` (e.g. DD-LEH-MRM-0xx). `knownSkuFloor()` folds the max design number from both product tables into every new-design mint and peek, permanently — additive safety beyond the spec.
7. **Final acceptance run (21 Jul)** — RPC parallel/duplicate/floor tests pass; kf parity verified (1250→01.2, 12500→12.5, blank→--.-); print-data returns only coded strings; roll-PDF page boxes exactly 38×25 and 79×25; staff reach the generator but not vendors/receipts; §8.6 grep clean; live E2E: vendor→receipt GR-20260721-001 with ?sku= prefill, mismatch badge and audit rows (test data removed). Sheet importer/mirror/floor remain blocked on operator step §12.2 (Editor grant); everything else self-heals on the first cron after the grant.
8. **Post-build adversarial review fixes (21 Jul, pre-dawn)** — 20 review findings triaged by direct inspection (verifier agents rate-limited): FIXED backup coverage (all Phase 1 tables + product_vendor_info/sync_ignored_skus/order_counters added to both exporters), PostgREST 1000-row truncation (fetchAll pagination on registry + receipt-line reads), createReceipt replay honoured only when lines landed, updateReceipt insert-before-delete, deleteReceipt row-before-photo, comma-tolerant amount parsing, ?sku= prefill merges with saved draft, bill-photo failures surfaced, inactive vendor stays pickable on edit, IST 7-day cutoff, scan handlers read via refs, quick-print honours saved calibration, calibration clamped, stale peek/price-fetch guards, combobox Enter/blur, print-iframe reuse, cron rejects unset CRON_SECRET. Deferred as acceptable: localStorage draft across logout on shared devices; GR reseed-after-counter-loss (counters now backed up, closing the realistic path).

## 9. Retail-Master number floor (25 Jul 2026)
The registry sheet grant (operator step) was still missing in production and the
sheet floor failed soft on every mint — silently, because the UI dropped the
route's warnings. Result: cat-subs absent from the wholesale tables re-minted
numbers the old tool issued long ago. Added a third floor source the service
account can already read — the retail "Drevi Product Master" (`PIPELINE_MASTER_SHEET_ID`,
default baked) — max()-ed with the product-table and registry-sheet floors, and
the generator UI now shows every mint warning plus the exact share-grant fix.
Variant-mode uniqueness against old-tool mints still needs the registry import,
i.e. the grant.

## 10. Label printing is viewer-based, not iframe (25 Jul 2026)
The hidden-iframe `window.print()` sent 38×25 mm pages to a dialog defaulting to
A4 paper — tags shrank onto letter stock. Print now opens the PDF in a visible
tab (pages ARE the stickers, one per page) and every print action reminds:
pick the 38×25 mm roll paper, 100% scale. The reference tool only ever
downloaded the PDF; the iframe path was our own embellishment.
