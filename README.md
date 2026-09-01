# Drevi Wholesale Portal

A login-gated B2B ordering portal for **Drevi Fashion**, live in production on
Vercel + Supabase (₹0/month stack). Approved boutique buyers browse the catalog
at wholesale prices and submit order requests; Drevi staff run the same catalog
in person — exhibition and in-store billing with QR scanning, GST bill-splits,
HSN-coded invoice PDFs and WhatsApp delivery — and run the back office on it:
goods-in with GST accounting, a stock ledger with stock-takes, a full order
lifecycle through delivery, and an AI photo **Studio** that takes a garment
from rack photo to approved product imagery and Opus-written copy.

Architecture, golden rules, and design tokens live in [`CLAUDE.md`](./CLAUDE.md).
Living operational docs are in [`docs/`](./docs) — see
[`TEST-REPORT.md`](./docs/TEST-REPORT.md) (full portal test pass, 4 Aug),
[`CUTOVER-RUNBOOK.md`](./docs/CUTOVER-RUNBOOK.md) (dev → prod promotion),
[`NEEDED-FROM-ANSH.md`](./docs/NEEDED-FROM-ANSH.md) (blocked-on-owner list) and
[`DECISIONS.md`](./docs/DECISIONS.md).

> **Status: LIVE**, taking real orders since the CMAI exhibition (July 2026).
> The productionization wave (Studio, GST receipts, LoVs, Drive consolidation,
> importers) is built and tested on the **dev** environment; promotion to prod
> follows `docs/CUTOVER-RUNBOOK.md`. The Google-Sheet sync stays on for about a
> month after cutover as a safety net, then retires (decision, 2 Aug).

---

## Feature map

### Roles

| Role | Who | Sees |
|---|---|---|
| `super_admin` | Ansh | Everything, including user management (`/admin/staff`) |
| `admin` | Arushi, Rakesh, Grishma, Jyoti, Riddhi | Everything **except** user management (full team access on BOTH environments — Ansh, 31 Aug) |
| `staff` | — (role kept for future hires) | Shop-floor tools: price checks, catalog, billing wizards |
| buyer | Approved retailers | Buyer catalog, cart, own orders |

Staff log in with a **shortname** (`ansh` → `ansh@drevifashion.com`) or full
email. Team logins currently use the `<name>` / `<name>123` convention on
**both dev and production** (Ansh, 31 Aug — set via `npm run db:seed-auth`,
which never touches the super-admin account and seeds its test buyer on dev
only; rotate through `/admin/staff` before any outside exposure). Buyers use
the credentials staff share via WhatsApp. Middleware gates every route by
role and account status on each request. The staff app is organised around a
five-space nav: **Home · Sell · Stock · Studio · Office**.

### Shop floor (all staff roles)

- **Retail Price** (`/admin/retail-check`) — built for tags whose printed
  price section has been cut off: scan the tag QR (or type the SKU) and quote
  the **retail price (sheet "Final MRP")** in real time. Shows the outfit photo
  so staff can confirm the garment. A **Sync Prices** button re-reads just the
  SKU + Final MRP columns (~2 s) and updates in place with a "prices as of
  HH:MM" stamp. Wholesale prices are **never rendered** on this page (the
  screen faces retail customers). Covers every sheet row, including garments
  hidden from the wholesale portal.
- **Wholesale Price** (`/admin/price-check`) — the same scan-first lookup for
  wholesale prices. Every scan auto-copies the SKU, unknown SKUs still show
  their Drive photo for the tagging workflow, and "price not set" items prompt
  the copy-SKU flow.
- **Catalog** (`/admin/catalog`) — browse-only grid of the whole collection
  with category chips, search **and scan**. The **"Sync from Sheet"** button
  runs the full product sync on demand — identical to the 10-minute cron.
- **Stock check** (`/admin/stock-check`) — scan-first stock lookup for the
  floor.
- **Stock take** (`/admin/stock-take`) — walk the rack: scan a tag (or type a
  SKU), the line shows title, **system quantity** and the variant's "kept at"
  location; type the counted quantity and move on. Re-scanning a tag returns
  to its line instead of duplicating. Committing writes one absolute `reset`
  per counted SKU to the stock ledger — a **partial** stock take is normal and
  never touches uncounted SKUs. The in-progress list survives reloads
  (localStorage draft).
- **SKU Generator** (`/admin/sku-generator`) — replaces the Apps Script SKU
  tool. New Design mints the next number per `CAT-SUB` atomically (advisory
  lock + a floor from the legacy sheet in dual mode + the product tables);
  Variant of Existing reuses a design's number with a new size + colour, with
  scan-to-resolve base and an inline duplicate guard (duplicates are refused
  with when/who and a "log a Goods Receipt instead" deep link). Category,
  sub-category, colour and size options come from the **live vocabulary**
  (static seed + the LoVs editor) — a code added in `/admin/lovs` mints
  immediately, no deploy. QRs encode the SKU string only and are generated on
  demand — never stored. The Print tab holds a per-device tray, Plain or
  With-price roll labels for the DCode DC421 Pro (38×25 mm calibrated PDF;
  price labels carry a coded vendor string and MRP — never raw costs), and a
  calibration panel. Every mint mirrors to the legacy Google Sheet while dual
  mode lasts; a 10-minute cron imports sheet-minted rows back.
- **Exhibition billing** (`/admin/exhibition`) — the session-based
  order-taking wizard for shows: sessions give orders their numbering prefix
  (`DX-YYYYMMDD-NNN`, gapless and race-safe via an atomic
  `next_order_number()` RPC), buyer capture with visiting-card photo, offline
  IndexedDB queues with idempotency keys, continuous QR scanning into the
  cart, price-visibility toggle, hold/resume, custom items, and finalise →
  invoice PDF via WhatsApp.
- **In-store billing** (`/admin/in-store`) — the same cart machinery,
  **without sessions**: it opens on "Who is this order for?" (buyer search,
  recents, New Buyer), then catalog → cart → finalise, numbering
  `IS-YYYYMMDD-NNN`. The cart carries per-line ₹/pc overrides (unpriced ₹0
  items are blocked from finalising), **GST bill-split ×N** (invoice shows one
  piece as N cheaper units; the real count is kept as `actual_qty`),
  order-level discount (% or ₹), GST none / 5 / 12 / 18 / custom (included in
  prices or added on top), advance + payment method, staff/buyer notes, and a
  mandatory-feeling **Taken by** staff selector so every walk-in order records
  who took it (`assisted_by`). Hold — next buyer / discard / finalise; a
  unique walk-in index prevents duplicate buyer rows.

### Studio (AI product imagery + copy)

The Studio takes a design from rack shot to publishable product photos and
copy. Everything is per-design, review-gated, and audited.

- **Board** (`/admin/studio`) — every design with its stage badge (Awaiting
  specs → Ready to generate → Needs review → Approved…), publish blockers per
  portal, an active-jobs ticker, and search/scan. Batch copy generation runs
  from here through the same generator as the workbench.
- **Workbench** (`/admin/studio/[designId]`) — per-angle review across
  **front / back / side / lifestyle / detail_1 / detail_2**:
  - **Four input modes per angle** — *Shoot* (camera/upload → a `source`
    image), *Use directly* (an existing image becomes source AND approved,
    engine `raw`, no cost), *Import* (an externally finished image,
    immediately approvable), *Generate* (queue a pipeline job). Detail angles
    are macro shots — never AI-generated, enforced server-side.
  - **Engines** (chips light up when their key is configured):
    **FASHN** model-swap (garment + pose kept, swapped onto a Drevi brand
    model; split **submit → poll** so Vercel's function limits never kill a
    run — `/api/pipeline/run` submits, the workbench polls
    `/api/pipeline/poll` every 4 s), **Seedream v4** edit via fal.ai
    (grey-studio background), **OpenAI** image edit (background
    normalisation; sources are transcoded to PNG at the door since the edits
    endpoint rejects JPEG). Cost estimates are shown on the buttons.
  - **Brand models** — the `DREVI_BRAND_MODEL_FOLDER_ID` Drive folder holds
    one subfolder per model (Model-a, Model-b, …); a per-design **Model**
    selector stores `designs.brand_model`, defaulting to the env's pick.
  - **Prompts** — every angle gets a default prompt built from the design's
    own verified specs; saved prompts always win and are marked
    human-edited.
  - **Review** — approve / reject / regen with candidate history and a
    source-vs-candidate compare slider. Approving archives the previous
    production image (moved to the folder's `_archive/`, row marked).
  - **Crop / Rotate** — an in-workbench crop sheet (drag-crop + 90° rotate)
    that saves a derived image (`role: crop`, `derived_from` set) ready for
    review — no round-trip through a photo editor.
  - **Sync Drive** — registers photos dropped **directly into the design's
    wholesale_photos folder** (they don't pass through the portal, so the
    database doesn't know them) as picker options. The picker pool = every
    registered image of the design.
  - **Copy panel** — one vision call (up to 3 approved images at 800 px +
    the spec-built prompt) returns strict-JSON title / description / tags.
    **Defaults to Opus (`claude-opus-5`) for every tier** (decision, 4 Aug);
    Sonnet/Haiku remain selectable per design with inline cost estimates.
    Generation is **locked until the design's specs are verified**
    (`STRICT_SPEC_MODE`, default on) — the button says so and links the
    Product Master rather than sitting silently disabled. Drafts are
    editable inline; edits after approval revert status to draft and flip
    live portals to `changes_pending`.
  - **Destination strip** — the same gate functions the pushes use, showing
    per-portal (wholesale / Shopify) blockers truthfully. Pushes create
    DRAFT products while `SHOPIFY_ENABLED` is off.
- **Product Master** (`/admin/studio/master/[designId]`) — the admin editor
  behind the workbench: specs (fabric, handwork, origin) with the
  **"Confirmed by Rakesh"** verification flag that unlocks copy; pricing
  (last ex-GST cost from receipts → tier multiplier → auto-MRP ₹…99 with
  manual override); **HSN (all sizes)**; supplier availability; per-variant
  rows with stock, wholesale price and the **"kept at" physical location**
  field.
- **Specs page** (`/admin/specs/[designId]`) — a price-free spec + supply
  editor, safe for counter devices.

### Back office (admins)

- **Dashboard** (`/admin/dashboard`) — money tiles (orders, pieces, sales,
  advance in, balance due) with **Today / 7 Days / 30 Days / This Month /
  All Time / Custom** ranges (custom = any from/to date pair) on IST day
  boundaries, plus four breakdowns: **By Product** (real pieces, GST-split
  aware), **By Vendor**, **By Customer** (linked to buyer pages), and
  **Reorder** — the purchasing table with vendor name, tap-to-copy vendor
  SKU, last cost and receipt date, pieces sold, current stock, vendor filter
  chips, search + scan (also standalone at `/admin/reorder`).
- **Orders** (`/admin/orders`) — search by order number, buyer, phone **or
  item SKU/title** (scanning a garment tag filters to every order containing
  it), date chips, **status filters across the full lifecycle** and source
  filters (Portal / Exhibition / In-store), sortable columns with an
  on-screen totals line. Rows are multi-selectable for **bulk actions**
  (Confirm · Mark packed · Mark delivered), each gated to eligible statuses
  with a done/skipped report.
  - **Line-level confirmation + split billing** (18 Aug) — for wholesale
    carts, every line carries its own state: **Confirm** (reserves stock for
    that line immediately), **Hold** (with an availability note the customer
    sees on their order page), or Pending. **Generate bill** invoices the
    confirmed-and-unbilled lines as `<order>-B1`, `-B2`, … (snapshotted in
    `order_bills`, each with its own PDF) — so one order can be billed in
    batches as held items arrive. A billed line is immutable. Percent
    discounts apply to every bill; a ₹ discount and the order's advance
    apply to the first bill only. Held lines are skipped by a whole-order
    Confirm, and per-line stock flags make double-moves impossible whichever
    path confirms.
  - **Past-dated billing** (18 Aug) — the cart's "Bill date" field (and the
    per-order Generate-bill sheet) accept any past date, never a future one:
    the order number's day, `submitted_at` and dashboard bucketing all follow
    the chosen date.
  - **Lifecycle** — `submitted → confirmed → packed → out_for_delivery →
    delivered` (plus `cancelled`; legacy `fulfilled` still recognised).
    Transitions are compare-and-swap guarded server-side so a double-tap can
    never double-move stock: stock leaves the shelf **once**, at confirm
    (negative stock is allowed by design — the catalog is largely
    made-to-order, negative = owed to production), and returns on a
    post-confirm cancel. Each stage stamps its timestamp.
  - **Dispatch** — the Out-for-Delivery sheet captures courier, AWB/tracking
    number, a note and an optional **tracking-sheet photo** (stored in the
    private `order-attachments` bucket) in one motion.
  - **Order detail** — items with zoomable photos, GST-split annotations,
    per-line **HSN chips** (tap to edit; a datalist of every HSN already in
    the catalog prevents near-duplicates), price-override notes shown as
    *internal* ("not on the invoice"), discount/tax/advance breakdown,
    **Edit** (buyer profile sheet — business, owner, phone, city, GSTIN,
    address, transport, broker — editable right from the order), status
    buttons for the next stages, **Send Invoice** (available at any
    non-cancelled stage), **Download PDF** (direct file download),
    **Share PDF / WhatsApp buyer**, **Refresh from Catalog** (pulls
    title/photo/HSN changes into the order's lines — prices never move; the
    same pass also runs automatically inside the sheet sync), Cancel, and
    **Modify Order** — a full re-bill in real pieces × real price with a
    "Bill as ×N" split factor, add-by-search/scan, custom lines, and every
    billing term pre-filled and recomputed server-side.
- **Goods receipts** (`/admin/receipts`) — two intakes share the GR numbering
  and history:
  - **Delivery intake v2** (`/admin/receipts/new`, `RECEIPT_INTAKE_V2`) —
    "one garment at a time — mint, photograph, count, price and capture
    supply in a single motion": pick the vendor (chips + quick-add), set the
    delivery's **GST treatment** — *Kaccha* (no GST) or *Pakka* with **5% /
    18%**, **included in prices or added on top** — then per garment:
    scan an existing tag **or** mint a brand-new SKU inline (category →
    sub-category → colour → sizes from the live vocabulary, HSN pre-filled
    with the default), shoot the ident photo (binds to the SKU immediately,
    stored in the design's Drive folder), set counts and unit cost, and add
    to the delivery. Saving writes the receipt + lines, posts `receipt`
    stock movements, creates hidden catalog rows for new SKUs (invisible
    until the Studio approves them), links the vendor at design **and** SKU
    level, and records `last_cost` **ex-GST** (input credit is claimed —
    pricing runs on the true cost; decision, 2 Aug). Save & Print sends the
    new tags to the label tray.
  - **Classic receipts** (`/admin/receipts`) — GR-numbered records with
    vendor, date, GST treatment, optional bill photo (private bucket) and
    bill amount with a mismatch badge, scan-in lines, edit/delete with audit
    trail. The receipt detail shows the GST line ("Pakka · GST 5% (incl.)")
    and links every line to its product / specs / studio pages.
- **Buyers** (`/admin/buyers`) — sortable/filterable table with WhatsApp
  links, pending-review counter, add-buyer flow. The buyer page has
  credential management (create / reveal / regenerate / change / share, all
  audit-logged), status control, order history with lifetime spend, notes,
  activity trail, vCard export, and the full profile editor including
  visiting-card photo.
- **Vendors** (`/admin/vendors`) — supplier records with **search**, receipt
  counts, last-receipt dates and lifetime purchase value; the vendor page
  lists every goods receipt (imported history included) and carries extended
  fields plus **business-card and person photos** (`vendor-photos` bucket).
  Scanning a garment tag resolves its vendor. Vendors with receipts
  deactivate, never delete.
- **Lists of values** (`/admin/lovs`) — the editable vocabulary behind
  minting, goods-in and the master editor: **categories, sub-categories,
  colours, sizes, fabrics, occasions**. Adding a code makes it available
  everywhere immediately; codes **deactivate rather than delete** (existing
  SKUs may reference them). Static built-in vocabulary is the seed; the LoVs
  table extends or deactivates on top, and server-side mint validation uses
  the same merged view.
- **Notes with photos, on every entity** — vendors, orders, buyers, designs
  and receipts all carry a NotesPanel (polymorphic `entity_notes`, photos in
  the `note-photos` bucket) for the details that would otherwise be
  forgotten.
- **Audit Log** (`/admin/audit`) — credential, catalog-edit, vendor, receipt
  and studio events with actor, timestamp, IP.
- **Staff** (`/admin/staff`) — staff accounts and roles (admins manage
  staff; only the super-admin manages admins).
- **Manage Catalog** (`/admin/manage-catalog`) — edit any product field,
  upload/replace photos, hide/show, rename SKUs. Any manually edited field is
  **locked** against the sheet sync until unlocked; renamed SKUs join an
  ignore list so the old sheet row can't resurrect.

### Stock ledger

Migration 0026 introduced an append-only `stock_movements` ledger under
`current_qty`: `receipt` (+goods in), `order` (−confirm / +post-confirm
cancel), `reset` (absolute stock-take count — supersedes earlier arithmetic
for that SKU), `manual`, `correction`, `shopify_sync`. A reconcile endpoint
(`/api/admin/stock-reconcile`) checks cache vs ledger.

### Invoices (customer-facing PDFs)

Royal Noir layout via `@react-pdf/renderer`, stored in the private
`order-pdfs` bucket, delivered via Interakt WhatsApp or downloaded directly.
Every line shows **`SKU · HSN <code>`**; the default HSN is **6204** (women's
garments — set at mint, backfilled across catalog and existing orders).
Price-override history is **never** printed — "was ₹X" annotations live only
on the admin order page (fixed 3 Aug; all existing dev + prod invoices
regenerated). GST bill-splits render paise-aware unit prices.

### Buyer portal

Login-gated catalog at wholesale prices with stock states (in stock /
limited / made-to-order / sold out), MOQ rules with "request special
quantity", cart, and order-request submission. Buyers see their order page
and receive the invoice / order-request PDF via WhatsApp. Buyer-facing
queries select an **explicit column list** (`BUYER_PRODUCT_COLUMNS`) so
admin-only fields — costs, physical location — can never leak into a page
payload. The portal is invisible to the public and noindexed.

### UX golden rules (applied portal-wide)

1. **Every search has a Scan button** — anywhere you can type a SKU you can
   scan a tag instead.
2. **Every photo is clickable → full-screen zoom** (shared
   `Lightbox`/`ZoomImage`).
3. **Every data table sorts by clicking its column headers** (shared
   `useSort`/`SortTh`).
4. **Forms stay usable with the keyboard open** (`KeyboardInset` visual-
   viewport padding).

---

## Photos: the consolidated Drive store

Design photography lives in **one Shared-Drive folder** (`wholesale_photos`,
`DRIVE_DESIGN_FOLDER_ID`), one subfolder per design group named
`BASE-SKU-COLOR` (e.g. `DD-SAR-PRD-044-GLD`), with an `_archive/` child for
superseded production images.

- **Dual backend, one front door** (`design-image-store.ts`): with the Drive
  folder configured, every upload (ident shots, angle sources, imports,
  generated candidates, crops) goes to the design's Drive folder with
  conventional names (`front__src__01.jpg`, `front__gen__02.png`, …); without
  it, files land in the portal's `design-images` bucket as `sb:` refs. Both
  kinds serve through `/api/drive-photo` (which also serves the auxiliary
  buckets), with sized thumbnails — Google transcodes HEIC in thumbnail
  renditions, so phone photos render everywhere.
- **Folder matching** never guesses: exact group name → base-SKU folder →
  single variant folder; ambiguity is reported and skipped.
- **Registration** — the picker pool reads the `design_images` table, so
  photos dropped straight into a folder are registered either by the
  workbench's **Sync Drive** button (one design) or
  `scripts/ingest-drive-photos.mjs` (all designs; the 4 Aug backfill linked
  137 folders and registered 866 photos). A **unique index on
  `(design_id, file_ref)`** (0040) plus conflict-ignoring upserts make both
  paths idempotent and race-safe.
- The buyer-facing catalog thumbnails still come from the sheet-sync photo
  chain into the public `product-photos` bucket until cutover retires it.

## Sync pipeline (legacy, retiring ~1 month post-cutover)

The *Wholesale Drevi Product Master* sheet (`WHOLESALE_SHEET_ID`, tab
`Master`, two-row headers matched by suffix) remains the nightly source for
catalog fields until the portal fully takes over as master.

- **Products** → `wholesale_products` (title, description, category, colour,
  fabric, price, visibility, MOQ, stock, restock). **HSN is only written when
  the sheet actually provides one** — a sheet without the column can never
  blank portal-set codes.
- **Procurement + retail** → `product_vendor_info` (admin-read-only; cost
  prices never ride along to buyer queries): vendor name/ID/SKU, last cost,
  last receipt date, `Final MRP` as `retail_price`.
- **Photos** — three-source Drive chain → `product-photos` bucket, ~s800
  thumbnails, all-or-nothing per SKU, budgeted per run, 35 s deadline.
- **Manual edits win** — Manage-Catalog locks are never overwritten; renamed
  SKUs are skipped; admin visibility choices are never auto-toggled; a
  transiently bad sheet that would hide most of the storefront skips the hide
  pass with a loud warning.
- **Auto order-refresh** — after each sync, open orders pull catalog
  title/photo/HSN changes (never money) through the same
  `refreshOrderFromCatalog` used by the button on the order page.
- **Triggers** — GitHub Actions cron every 10 minutes (`sync-cron.yml` →
  `/api/cron/sync-products`, gated by `CRON_SECRET`), the Catalog page's
  **Sync from Sheet** button, Retail Price Check's fast **Sync Prices**.
  `SHEET_SYNC_ENABLED` is the master switch for retirement.

## One-time importers (productionization)

`scripts/import-sheet-data.mjs` — idempotent, **dry-run by default**
(`--write` to commit, `--prod` to target production):

- **Vendors** from Reference!AD ∪ Master vendor names (the master sheet is
  authoritative for vendor-per-SKU — decision, 3 Aug), case-deduped.
- **Goods-receipt history** from the Receipts tab: grouped by
  supplier+date+invoice into stable `GR-IMP-<hash>` receipts, vendor
  fallback from Master, **blank quantities default to 1** (decision, 3 Aug),
  top-up passes add missed lines to existing receipts, silent skips are
  named in the report. **History only — no stock movements** (stock truth
  comes from stock-takes).
- **LoVs** from the Reference tab (162 seeded).
- **Master extra columns** (pricing tiers etc.) onto 169 SKUs.

`scripts/migrate-photos-to-drive.mjs` — moved portal-bucket photos into
wholesale_photos and rewrote their refs (executed). `scripts/
ingest-drive-photos.mjs` — registers folder-dropped photos (see above); both
page their reads explicitly past PostgREST's silent 1000-row cap.

## Operations

- **Backups** — hourly GitHub Actions run (`backup.yml`) exports the core
  tables **and every storage bucket in the backup list** via
  `/api/cron/backup`, storing a gzip artifact.
- **Watchdog** — `watchdog.yml` health-checks the deployment every 10
  minutes with auto-restore. `master-mirror.yml` mirrors mints to the legacy
  registry sheet; `pipeline-runner.yml` is the parked GitHub-hosted
  generation runner (generation currently runs in-process on Vercel).
- **Order numbering** — `next_order_number(prefix, day)` RPC reserves
  numbers atomically; duplicates are impossible under concurrency. Goods
  receipts share the same counter machinery.
- **Idempotency** — buyer captures and orders carry client-generated UUIDs
  (`client_ref`); offline replays and double-taps resolve to the existing
  row. Stale generation jobs are swept after 15 minutes.
- **Offline** — the wizard autosaves the working order to localStorage,
  parks held orders, and queues captures/orders in IndexedDB with a visible
  retry/discard panel.
- **Maintenance endpoints** — `/api/admin/regenerate-invoices` (bulk PDF
  regeneration, used for the HSN/no-override rollout),
  `/api/admin/stock-reconcile`.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind (Royal Noir tokens) ·
Supabase (Postgres + Auth + RLS + Storage) · `googleapis` (Sheets + Drive) ·
`@react-pdf/renderer` · Interakt (WhatsApp) · **Anthropic API** (product copy,
Opus 5 default) · **fal.ai** (Seedream v4) · **FASHN** (model swap) ·
**OpenAI images** (background edit) · `sharp` (HEIC/JPEG→PNG transcode) ·
Vercel (Hobby) · GitHub Actions (cron/backup/watchdog/mirror).

## Environment

Copy secrets into `.env.local` (gitignored — never commit). The full list
lives in `CLAUDE.md → Environment variables`; `src/lib/env.ts` validates
required vars. Highlights:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin client (never shipped to the browser) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Inline JSON **or** a file path; Sheets read + Drive **write** (Content Manager on wholesale_photos) |
| `WHOLESALE_SHEET_ID` | Wholesale Master sheet |
| `SHEET_SYNC_ENABLED` | Master switch for the legacy sheet sync |
| `DRIVE_DESIGN_FOLDER_ID` | The consolidated **wholesale_photos** Shared-Drive folder (design photo store) |
| `DREVI_BRAND_MODEL_FOLDER_ID` | Brand-model pose folders (Model-a, Model-b, …) for FASHN |
| `DREVI_BRAND_MODEL` | Default brand-model subfolder |
| `DRIVE_PHOTOS_FOLDER_ID` / `DRIVE_TRYON_FOLDER_ID` / `DRIVE_INPUT_FOLDER_ID` | Legacy sheet-sync photo chain |
| `ANTHROPIC_API_KEY` | Copy generation |
| `COPY_MODEL` | Copy model override (default `claude-opus-5`) |
| `STRICT_SPEC_MODE` | Refuse copy for unverified-spec designs (default on) |
| `FASHN_API_KEY` / `FASHN_POLL_TIMEOUT_MS` | FASHN model swap |
| `FAL_KEY` / `DREVI_SEEDREAM_SIZE` / `DREVI_SEEDREAM_SAFETY` | Seedream via fal.ai |
| `OPENAI_API_KEY` / `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` | OpenAI image edit |
| `RECEIPT_INTAKE_V2` | Enables the delivery-intake capture flow |
| `SHOPIFY_ENABLED` / `SHOPIFY_STORE_DOMAIN` | Shopify push (drafts while off) |
| `CRON_SECRET` | Bearer token for `/api/cron/*` |
| `INTERAKT_API_KEY` | WhatsApp sends (degrades gracefully without it) |
| `SUPABASE_ACCESS_TOKEN` | Management API token — only for `npm run db:migrate` |
| `SKU_REGISTRY_SHEET_ID` / `SKU_REGISTRY_TAB` / `SKU_DUAL_MODE` / `SKU_MIRROR_DISABLED` | Legacy SKU registry transition |
| `AVAILABILITY_BUFFER_DAYS` / `HANDLING_DAYS` / `LIMITED_THRESHOLD` / `SUPPLY_STALE_DAYS` | Availability tuning |

## Local development

```bash
npm install
npm run dev          # http://localhost:3000  (redirects to /login)
npm run build:local  # production build into .next-build (leaves dev server alone)
npm test             # vitest unit tests (GST math, availability, ledger, …)
```

### Dev environment (safe sandbox)

`npm run dev` runs against the **DEV** Supabase project automatically —
`.env.development.local` (gitignored, dev keys) overrides `.env.local` in dev
mode only. `.env.local` stays pointed at production.

- **Dev database**: Supabase project `qvnvxcdyvcsgxulbcmzm` ("Drevi Wholesale
  DEV") — full schema (0001–0040) + a snapshot of prod data. Staff logins use
  the same usernames with the `<name>123` convention.
- **Dev deployment**: https://drevi-wholesale-dev.vercel.app — a second
  Vercel project (`drevi-wholesale-dev`) wired to the dev database.
  **Deliberately disconnected from Git** (3 Aug, after a prod push briefly
  deployed `main` onto the dev domain): deploy the `dev` branch to it
  **only** via CLI — `npx vercel --prod --yes` from the repo (CLI-linked to
  the dev project). The production project auto-deploys from pushes to
  `main` and ignores `dev` via `vercel.json`.
- **Safety rails**: `SKU_MIRROR_DISABLED=true` in both dev environments;
  Google Sheets are only ever read from dev; GitHub Actions crons target
  production only. The dev Vercel project carries the full engine key set
  (FASHN / FAL / OpenAI / Anthropic) plus the Drive folder ids, so Studio is
  fully functional on the dev URL.
- **Workflow**: branch off `dev`, hack, verify locally or on the dev URL,
  then merge to `main` per `docs/CUTOVER-RUNBOOK.md` when it's ready.

### Database

```bash
npm run db:migrate    # applies supabase/migrations/*.sql via the Management API
npm run db:seed-auth  # dev auth users for the seeded staff + a test buyer
npm run db:backup     # manual backup (same exporter the hourly cron uses)
```

Migrations `0001`–`0040` are idempotent (the runner replays the whole chain).
Highlights beyond the launch set (`0001`–`0014`: schema/RLS, carts,
credentials, buyers, exhibition, discounts + splits, atomic numbering,
idempotency, catalog locks, vendor info, retail price, SKU registry,
vendors + receipts): audit events (`0015`), Studio schema — designs, angles,
jobs, review audit, publishing, master ownership (`0016`–`0020`), notify-me
(`0021`), design-images normalisation + lifestyle angle (`0022`–`0023`),
receipt intake v2 (`0024`), supply availability (`0025`), **stock ledger**
(`0026`), copy controls (`0027`), design-images bucket + Seedream jobs
(`0028`–`0029`), vendor photos (`0030`), **order lifecycle + tracking**
(`0031`), walk-in unique (`0032`), **entity notes** (`0033`), **HSN + 6204
backfill** (`0034`–`0035`), brand model (`0036`), **receipt GST** (`0037`),
**LoVs + master columns** (`0038`), **variant location** (`0039`), unique
`(design_id, file_ref)` (`0040`).

### Scripts

```
scripts/
  import-sheet-data.mjs      one-time importers (vendors, receipts, LoVs, master) — dry-run default
  ingest-drive-photos.mjs    register folder-dropped Drive photos (idempotent)
  migrate-photos-to-drive.mjs  sb:-bucket → wholesale_photos migrator (executed)
  drive-folder-audit.mjs     folder-name ↔ design matching audit
  backup.mjs · seed-auth.mjs · apply-migration.mjs · probe-sheet.mjs
  retrofit-*.mjs             retrofit baseline / reconciliation tooling
```

### Sync manually

```bash
# dev (no secret, dev only):
curl http://localhost:3000/api/dev/sync-now

# production-equivalent:
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/sync-products
```

## Deploy (Vercel)

1. Import the repo; set every variable from `CLAUDE.md → Environment
   variables` as Vercel project env vars.
2. Scheduling runs on **GitHub Actions** hitting the `CRON_SECRET`-gated
   endpoints — no Vercel cron quota needed.
3. Push to `main` → the production project auto-deploys. The dev project is
   CLI-only (see above).
4. Dev → prod promotion of the productionization wave follows
   `docs/CUTOVER-RUNBOOK.md` (backup → migrate → importers → merge → env →
   regression).

## Troubleshooting

**Sync returns errors / 0 rows:** missing Master columns (the error lists
what it found), service-account not shared, or the field is **locked** by a
manual edit — unlock in Manage Catalog.

**Copy generation is greyed out:** the design's specs aren't verified — open
Product Master and tick "Confirmed by Rakesh" (or set
`STRICT_SPEC_MODE=false` to drop the gate entirely).

**An engine chip is disabled:** its key is missing in that environment
(FASHN also needs `DREVI_BRAND_MODEL_FOLDER_ID`). FASHN runs additionally
require account credits.

**Photos in the Drive folder don't show in the picker:** hit **Sync Drive**
on that design's workbench (or run `scripts/ingest-drive-photos.mjs`). If
sync reports no folder, the folder name doesn't match `BASE-SKU-COLOR`
closely enough, or two folders match ambiguously.

**Login fails:** staff — shortname or full email, account must be active;
buyer — credentials not yet created or status isn't `active`.

**An unpriced item blocks Finalise:** intended — price the line or the
product, then retry.

## Project structure

```
src/
  app/
    admin/             home, dashboard, orders, buyers, vendors, receipts (+ new),
                       catalog, manage-catalog, price-check, retail-check,
                       stock-check, stock-take, reorder, sku-generator,
                       exhibition, in-store, studio (+ master), specs, lovs,
                       audit, staff
    (buyer routes)     catalog, cart, product/[sku], order/[id], login, wholesale
    api/               cron/*, admin/{regenerate-invoices,stock-reconcile},
                       pipeline/{run,poll,jobs}, sku/*, drive-photo, orders,
                       scan, health, dev/*
  components/          QrScanner, Lightbox/ZoomImage, useSort/SortTh,
                       KeyboardInset, OfflineSync,
                       admin/* (NotesPanel, HsnInput, wizards, …)
  lib/                 sync, sheets, drive, drive-design, design-image-store,
                       storage, order-pdf, order-finalize, order-catalog-sync,
                       stock-ledger(+core), gst, hsn(+default), availability,
                       share, audit, interakt, offline, studio/{load,copy,
                       copy-models,state}, pipeline/{engines,finish}, sku/*,
                       supabase/{client,server,admin}
  middleware.ts        auth + status/role gating
supabase/migrations/   0001–0040 (idempotent)
scripts/               importers, Drive tooling, backup, seed, retrofit audits
.github/workflows/     sync-cron, watchdog, backup, master-mirror, pipeline-runner
docs/                  TEST-REPORT, CUTOVER-RUNBOOK, NEEDED-FROM-ANSH, DECISIONS, …
```

## License

MIT — see [LICENSE](./LICENSE).
