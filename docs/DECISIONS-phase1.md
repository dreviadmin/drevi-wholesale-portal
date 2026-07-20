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
