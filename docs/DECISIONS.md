# Decisions log — unified Drevi App build (guide §0.4)

One line per deviation from the master build guide, with rationale. Phase 1 decisions live in `DECISIONS-phase1.md`.

- **25 Jul 2026 · Dev-only delivery**: per Ansh, every stage lands on the `dev` branch + dev Supabase (`qvnvxcdyvcsgxulbcmzm`) + dev Vercel project (`drevi-wholesale-dev`) — production (`main`) is untouched until the app is complete. The guide's "one stage = one PR" becomes "one stage = one dev-branch commit series + dev deploy".
- **25 Jul 2026 · Migration numbering**: repo already had `0015_audit_events.sql` before this guide, so guide numbers shift by one from Stage 3 on (guide 0015_studio → repo 0016, guide 0016_pipeline_jobs → 0017, etc.).
- **25 Jul 2026 · Prototype absent (ANSH-02)**: `docs/design/drevi-app-prototype.html` isn't in the repo or Downloads; Stage 2 is built from the guide's §6 textual spec + existing Royal Noir tokens. Side-by-side fidelity pass parked until the file lands.
- **25 Jul 2026 · Stock space is admin+ in nav**: guide lists sku-generator as staff+ inside Stock, but the Stage 2 done-when requires a staff login to see ONLY Home+Sell. Resolution: Stock space hidden from staff in nav; staff reach the generator via the Home "New SKU" quick action (route access unchanged, staff+).
- **25 Jul 2026 · Manage Catalog homed under Office**: the guide's Office list omits it, but it must stay reachable until Stage 8 re-homes it as the master editor.
- **25 Jul 2026 · Studio space defined but empty**: nav config carries the space with `items: []` (hidden) until Stage 3 ships the board — avoids a dead tab.
- **25 Jul 2026 · Prototype fidelity pass (post-delivery)**: cockpit aligned to the prototype (role in greeting, full-width gold "Scan a tag" heading the quick actions, count pills on inbox rows, icon+subtitle space tiles). Two deliberate deviations kept: (1) bottom tabs open a space's FIRST screen rather than a space-landing tile page (the prototype's Sell landing incl. "Held orders" is deferred — one tap saved on the common path; revisit if the team misses it); (2) scan-sheet action rows have no per-row subtitles. Tab order matches the prototype automatically once Stage 3 fills Studio (Office overflows to Home tiles for super_admin).
- **26 Jul 2026 · Stage 4 runner scope**: `scan_drive` is fully implemented; `tryon/openai_bg/vision/preprocess/copy` job types finalise to a clear error until Stages 5–6 land their contracts (per-angle prompts, candidate registration UX) — hosted execution is blocked on ANSH-04 anyway. Guide's "FASHN e2e on Actions" done-when moves to Stage 5 + ANSH-04.
- **26 Jul 2026 · scan_drive semantics**: designs.drive_processed_id carries the PHOTOS folder (166Y…, the tag-shot corpus — the pipeline's own PROCESSED root is per-run and lives in its env); the PHOTOS front shot is registered as a `raw` candidate and auto-APPROVED for the front angle when none exists (it IS the photo buyers already see), which is what makes the board truthful about pre-app work. INPUT images map to angles by filename (front/back/side/close), else first image → front source.
- **26 Jul 2026 · pipeline/ copied from ~/Documents/drevi/pipeline/scripts** (sources only — .venv, .env, service-account json excluded; gitignored). Local runs use the original .venv's python until the repo pins its own.
- **26 Jul 2026 · Stage 5 tryon + HEIC**: the runner's `tryon` handler ships with Stage 5 (per-angle FASHN via the pipeline's own FashnClient; pose from DREVI_BRAND_MODEL_FOLDER_ID, model per params.brand_model default A). Raw INPUT sources are HEIC, which FASHN can't ingest — the runner converts to a `<name>_web.jpg` beside the source once and reuses it. Verified locally end-to-end (2 credits, one 1k·balanced render, candidate registered → UI review → D3 flip). Actions-hosted e2e still rides on ANSH-04.
- **26 Jul 2026 · Stage 6 copy in TypeScript, one implementation**: single generate AND board batch both run the server-side `generateCopyForDesign` (Anthropic vision, D9 models, built-in template until ANSH-02's copy-template.md lands). The `copy` pipeline-job type stays reserved for hosted batch after ANSH-04 — running batch through the app server avoids duplicating the prompt contract in Python. Batch capped at 10 designs/call.
- **26 Jul 2026 · Stage 7a publish ownership**: the wholesale push writes the published set into `wholesale_products.image_urls` for every size variant of the group AND adds `image_urls` (+`description` when approved copy ships) to `locked_fields` — reusing the existing manual-edit lock so the 10-min sheet sync can never claw back a published set. Buyer surfaces read image_urls as before → published designs update instantly, unpublished ones are untouched. `product_images` stays the canonical registry (Stage 9 galleries + 7b Shopify media read from it).
- **26 Jul 2026 · Stage 7b implemented + parked**: full Shopify DRAFT push (productCreate/productUpdate + productCreateMedia over the published set, cached client-credentials token) behind `SHOPIFY_ENABLED` — the flag stays OFF because flipping it creates draft products in the REAL store; that switch is Ansh's (ANSH-05). Variant/price sync into Shopify lands with Stage 8's pricing model.
- **27 Jul 2026 · Stage 8 shipped WITHOUT the flip**: master editor (specs + Rakesh toggle, auto-MRP ₹…99 with override, publish toggles, per-variant stock/wholesale with locks), migration 0020 (guide 0018), nightly App Mirror (WORKS — the SA already holds write on the wholesale sheet; 198 rows on first run), /api/dev/master-diff, and the SHEET_SYNC_ENABLED kill-switch (default ON). The cutover flip + cleanup migration + CLI default swap stay parked on ANSH-07 after a clean parallel week.
- **27 Jul 2026 · MRP overrides seeded from the sheet**: the backfilled cost×multiplier auto-MRP disagreed with the sheet's real pricing (~2.0× vs 2.5×), so designs.mrp_override was seeded from the sheet's Final MRP — the sheet IS today's truth, and the multiplier only guides designs priced after cutover. Day-1 diff noise drops from 164 to 12 (all live-sheet drift).
- **27 Jul 2026 · Manage Catalog stays during transition**: variant tools (photos/visibility/rename/locks) remain there; the master editor owns design-level specs/pricing/publish. Full merge + redirect happens at the flip, when locks and the sheet sync die together.
- **27 Jul 2026 · Stage 9 buyer home at /home**: buyers land on the storefront home (login + middleware redirect); `/catalog` and every other buyer URL keep working unchanged (D10). Notify-me is buyer-RLS'd (own rows only, partial-unique on open requests); the automated WhatsApp nudge stays a parked follow-up per the guide — the strip + admin count are the Stage 9 scope.
- **27 Jul 2026 · Dev buyer login for storefront testing**: DEV ONLY — the RIVAAZ buyer row (2 real orders) got `rivaaz.dev@drevifashion.com` / `rivaaz123` credentials so the reorder rail could be verified against genuine history. No production buyer was touched; exhibition buyers still have no portal logins.
- **27 Jul 2026 · Stage 9 buyer surfaces**: `/home` is the buyer landing (login + middleware redirect); `/catalog` stays reachable (D10 — buyer URLs never change). Reorder ranks by lifetime real pieces (actual_qty when a GST split was billed) then recency. "New this week" keys off `product_images.published_at` — pre-Studio products never appear there, which is correct: the rail advertises newly *published* work. Notify-me is buyer-RLS'd (own rows only), staff read via service role; the automated WhatsApp nudge stays a parked follow-up per the guide.

## Retrofit spec v1.3 (27 Jul 2026 →)

- **R0 · A1 is FALSE — cutover not complete**: `SHEET_SYNC_ENABLED` is unset (sync ON) because ANSH-07 sign-off hasn't happened. §3.7 interim sync guard therefore APPLIES: the product sync skips `origin='app'` designs entirely (never hides/overwrites/deletes them — they legitimately have no sheet row). Guard is removed when the cutover flag flips.
- **R0 · `devices` table absent — Addendum 2B was never built here**: this repo went Master Build Guide Stages 1–9 only; there is no device registry, no PIN unlock, no `floor` scope. Every "floor scope" requirement in the retrofit (§5.11 delivery intake, §6.2 specs view, §10.2b stock take) is implemented with the **admin role gating that exists**, on routes designed to be device-friendly (big targets, scan-first). Wiring them into device scope is a one-line nav/middleware change if Addendum 2B is built later — logged as ANSH-20.
- **R0 · script extension**: repo convention is `scripts/*.mjs` (no ts-node/tsx in devDependencies); the spec's `.ts` script names ship as `.mjs` with the same behaviour and output paths.
- **R0 · baseline**: 188 designs / 186 with angles (closeup present, A3 true), 124 image_candidates (112 approved + 12 generated), 258 legacy `source_ref`s to promote, 2 product_images rows, 1 live publish target, 200 wholesale_products (1 with stock > 0). Full report in `docs/RETROFIT-BASELINE.md`.
- **R1 · designs.origin collision**: the spec adds `designs.origin ('sheet','app')`, but `designs.origin` already exists from Stage 3 as a spec-mirror field meaning *place of origin* (e.g. "Surat"). Provenance therefore ships as **`origin_source`** with the same check constraint; every reference in code uses `origin_source`. Overwriting the existing column would have destroyed spec data on live rows.
- **R1 · stock column name**: the spec says `wholesale_products.stock`; this repo's column is **`current_qty`**. The ledger, canonical function and all cache writes use `current_qty`.
- **R1 · two ordering bugs in the spec's 0022**: (a) `update ... set status='active'` runs *before* the old `image_candidates_status_check` is dropped, which the surviving constraint rejects — the drop now precedes the update; (b) the source-row promotion INSERT omits `engine`, which was `NOT NULL` — `engine` is now nullable, since only candidates have one. Both fixed in place; behaviour otherwise exactly as specified.
- **R1 · image status semantics**: `'generated'|'approved'` both collapse to `'active'`; approval is read exclusively from `design_angles.approved_image_id` (UI "Production" label and history now compare ids, not row status). Demotion writes `'archived'`.
- **R2 · separate write-scoped Drive client**: `lib/drive.ts` authenticates with `drive.readonly` (photo serving). Folder creation/upload/archive needs write scope, so `lib/drive-design.ts` holds its own JWT client with the full `drive` scope rather than widening the read path used by every buyer-facing image request.
- **R2 · service-account quota risk surfaced to ANSH-19**: uploads into a *My Drive* folder will fail with `storageQuotaExceeded` (service accounts have 0 personal quota — observed on 25 Jul when copying a sheet). The parent for `DRIVE_DESIGN_FOLDER_ID` should be a Shared Drive folder. Matching and reads are unaffected.
- **R3 · receipts create catalog rows**: an app-born design has no sheet row, so `saveDelivery` inserts a `wholesale_products` row per received variant — **hidden** (`wholesale_visible=false`, lock on that field) until Rakesh sets specs and price (§6.1 "Awaiting specs"). Without this the garment would exist as a design and a receipt line but never as a product.
- **R3 · §3.7 guard implemented (A1 false)**: the sheet sync now computes the set of `origin_source='app'` variants and (a) skips them on ingest and (b) excludes them from the hide pass, reporting the count as a warning. Delete when the cutover flips `SHEET_SYNC_ENABLED`.

### R5 — Studio input modes (v1.3 §7)

- **`useDirectly` renamed `applyImageDirectly`.** ESLint's `react-hooks/rules-of-hooks`
  treats any `use*` identifier as a hook, so a server action named `useDirectly`
  cannot be called from a callback. Behaviour is exactly the spec's mode B.
- **Angle prompts are computed, not stored, until edited.** `design_angles.prompt`
  starts null; `defaultAnglePrompt()` (src/lib/studio/prompts.ts) builds the
  uniform grey-studio prompt from the design's own specs at read time, so a spec
  correction flows into the prompt. Saving one marks `prompt_edited_by_human`
  and nothing regenerates over it.
- **`approveAsIs` no longer mints a duplicate row.** Post-0022 the source IS a
  `design_images` row, so approve-as-is approves it in place and archives the
  previous approval (§7.5). The legacy branch (source_ref with no source_image_id)
  still inserts, now carrying `design_id` and `role='source'`.
- **An approved source shows in the Production pane.** Sources are otherwise
  excluded from an angle's candidate list; the approved one is the exception,
  else a mode-B angle reads "none yet" while being approved. Compare hides
  itself when both sides are the same image.
- **Crop is hidden while uploads are off (ANSH-19).** A crop writes a new Drive
  file, so with `DRIVE_DESIGN_FOLDER_ID` unset the button does not appear —
  never a silent fallback to a legacy folder.

### R6 — Vision controls (v1.3 §8)

- **The prompt is computed until edited**, same rule as angle prompts:
  `design_copy.prompt` starts null and `defaultCopyPrompt()` rebuilds it from
  the design's specs at read time, so a spec correction flows through. Saving
  stamps `prompt_edited_by`; "Reset to default" clears it back to null.
- **Model registry, not free text.** `src/lib/studio/copy-models.ts` is the one
  list the panel and the generator share, so the estimate on screen is the
  estimate the run costs. `setCopyModel` rejects ids outside it.
- **`db:migrate` now defaults to dev.** It loaded `.env.local` — production —
  unconditionally, which sent 0022–0027 to prod. Fixed, and the full assessment
  is in docs/CUTOVER-LOG.md.

### R7 — Buyer availability (v1.3 §9)

- **`getStockState` is now a projection, not a second implementation.** The
  legacy four-state model (ready/limited/made_to_order/sold_out) that the cart,
  qty caps and the order PDF speak is derived from `computeAvailability`, so
  there is genuinely one brain. The per-SKU `restockable` boolean is the
  pre-supply-data stand-in; a design carrying real supply fields goes through
  `availabilityForSkus` instead.
- **Raw supply rows never leave `availability-load.ts`.** Buyer pages get the
  five-key object and nothing else, so no card, page or RSC payload can
  serialise vendor stock, the making MOQ or the individual lead-time
  components — only their sum reaches a buyer. Enforced by the firewall test.
- **"Limited" also covers stock below the buyer's MOQ.** A thin shelf is still
  worth showing honestly rather than reporting the design as unavailable.
- **`discontinued` beats stock on hand.** A retired design should not be
  re-promised even if a few pieces remain.

### R8 — Inventory ledger (v1.3 §10)

- **The cache is allowed to go negative.** `wholesale_products.current_qty`
  follows whatever the canonical function returns, including below zero. A
  negative reading means we shipped stock the books never had — usually a
  Shopify POS sale the app cannot see (ANSH-18). Clamping it at zero would hide
  exactly the discrepancy this ledger exists to surface. Buyer-facing code
  clamps for display (`computeAvailability`), so a negative never reaches a
  buyer as anything but "sold out".
- **Movements are written on a status TRANSITION, never on a re-save.** Stock
  leaves on confirm and returns as a `correction` if a confirmed order is
  cancelled; re-saving the same status writes nothing, so nothing double-counts.
- **A manual stock edit in the master editor now requires a note** and becomes
  a `manual` movement. The price half of the same save is unaffected.
- **`stock-ledger-core.ts` holds the pure math.** The server module keeps the
  `server-only` guard; the canonical calculation and its types live in a plain
  module so tests and client components can import them.
- **Drift report lives at `/admin/stock-check`** with the API at
  `/api/admin/stock-reconcile`, both in the Stock space. ANSH-20 (device/floor
  scope) is still parked, so both are admin-role gated.

### UX sprint review (30 Jul) — confirmed findings fixed

Five-dimension adversarial review of c97413b; confirmed findings fixed in the
follow-up commit:

- Invoice actions survive the new lifecycle: "Send Invoice" now renders for
  every non-cancelled status (a bulk-confirmed order marked packed had NO way
  to ever get an invoice), and `sendInvoice` refuses cancelled orders
  server-side.
- One `ORDER_STATUS_LABEL` map (src/lib/order-status.ts) — buyer order page,
  buyer home strip and admin buyer detail all rendered raw `out_for_delivery`.
- `applyStatus` is now compare-and-swap on the status it read: two concurrent
  confirms could both pass the gate and post stock movements twice. The loser
  now matches zero rows and reports "changed under you". Lifecycle timestamps
  only stamp on real transitions.
- Storage archives get a timestamp suffix and the DB ref updates only AFTER a
  successful move (a failed move could leave a row pointing at a non-existent
  _archive path; a re-used active name could alias two rows to one archive).
- Walk-in counter creation races resolve via a partial unique index (0032) +
  re-select.
- Stale `running` pipeline jobs (server died mid-generation) sweep to error
  after 15 min instead of hiding the Generate button forever.
- fashn chip also requires DREVI_BRAND_MODEL_FOLDER_ID; exotic capture formats
  (HEIC/WebP) transcode to JPEG at upload via sharp; wizard drafts carry
  takenBy; backup list actually includes the three new buckets (the earlier
  edit missed `as const` and silently didn't apply).

29 of 40 verifier agents died on a session usage limit; their findings were
triaged by hand — the ones above are the survivors that held up against the
code. The rest were duplicates or could not actually occur.

### Entity notes (30 Jul, Ansh)

"Every entity must have an extra column for additional notes (along with
photos) — for details we might forget." Implemented as ONE polymorphic log
(`entity_notes`, migration 0033) rather than a column per table: notes are
timestamped, authored, photo-carrying and never overwritten — a memory that
can't be lost by editing a single field. `<NotesPanel>` mounts on vendor,
order, buyer, design (product master) and receipt detail pages; `product` and
`session` types are reserved in the check constraint for future surfaces.
Photos live in the private `note-photos` bucket (backed up), served via
/api/drive-photo. Any staff can add; only admins delete.
