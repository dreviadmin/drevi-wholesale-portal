# Drevi Wholesale Portal

A login-gated B2B ordering portal for **Drevi Fashion**, live in production on
Vercel + Supabase (₹0/month stack). Approved boutique buyers browse the catalog
at wholesale prices and submit order requests; Drevi staff run the same catalog
in person — exhibition and in-store billing with QR scanning, GST bill-splits,
invoice PDFs and WhatsApp delivery. The product catalog syncs from the
**Wholesale Master Google Sheet** every 10 minutes, with photos pulled from a
per-SKU Google Drive folder.

Architecture, golden rules, and design tokens live in [`CLAUDE.md`](./CLAUDE.md).
The product spec and the locked visual prototype are in [`specs/`](./specs).

> **Status: LIVE.** Taking real orders since the CMAI exhibition (July 2026) —
> exhibition billing, in-store billing, retail price lookup, dashboard and
> back-office all in daily use.

---

## Feature map

### Roles

| Role | Who | Sees |
|---|---|---|
| `super_admin` | Ansh | Everything |
| `admin` | Arushi, Rakesh | Everything except super-admin staff management |
| `staff` | Jyoti, Grishma, Riddhi | Shop-floor tools: price checks, catalog, billing wizards |
| buyer | Approved retailers | Buyer catalog, cart, own orders |

Staff log in with a **shortname** (`ansh` → `ansh@drevifashion.com`) or full
email. Buyers use the credentials staff share via WhatsApp. Middleware gates
every route by role and account status on each request.

### Shop floor (all staff roles)

- **Retail Price** (`/admin/retail-check`) — built for tags whose printed
  price section has been cut off: scan the tag QR (or type the SKU) and quote
  the **retail price (sheet "Final MRP")** in real time. Shows the outfit photo
  (portal image, or its Drive photo as fallback) so staff can confirm the
  garment. A **Sync Prices** button re-reads just the SKU + Final MRP columns
  (~2 s) and updates in place with a "prices as of HH:MM" stamp — type a price
  into the sheet at the rack, tap Sync, quote it. Wholesale prices are **never
  rendered** on this page (the screen faces retail customers); even the product
  detail opens price-free. Covers every sheet row, including garments hidden
  from the wholesale portal.
- **Wholesale Price** (`/admin/price-check`) — the same scan-first lookup for
  wholesale prices. Every scan auto-copies the SKU (for pasting into the sheet
  when pricing new stock), unknown SKUs still show their Drive photo for the
  tagging workflow, and "price not set" items prompt the copy-SKU flow.
- **Catalog** (`/admin/catalog`) — browse-only grid of the whole collection
  with category chips, search **and scan** (a scanned tag opens that product's
  detail; hidden SKUs are reported as hidden rather than missing). The
  **"Sync from Sheet"** button runs the *full* product sync on demand — prices,
  fields, visibility and Drive photos, identical to the 10-minute cron — and
  reports `Synced N products · M photos refreshed`, with a last-synced
  timestamp otherwise.
- **SKU Generator** (`/admin/sku-generator`) — replaces the Apps Script SKU
  tool. New Design mints the next number per `CAT-SUB` atomically (advisory
  lock + a floor from the legacy sheet in dual mode + the product tables, so
  numbers never collide during the transition); Variant of Existing reuses a
  design's number with a new size + colour, with scan-to-resolve base and an
  inline duplicate guard. Duplicate variants are refused with when/who and a
  "log a Goods Receipt instead" pointer (admins get a one-tap deep link).
  QRs encode the SKU string only and are generated on demand — never stored.
  The Print tab holds a per-device tray (registry picker, bulk paste, scans),
  Plain or With-price roll labels for the DCode DC421 Pro (38×25 mm
  calibrated PDF; price labels carry a coded vendor string and MRP — never
  raw costs), and a calibration panel. Every mint mirrors to the legacy
  Google Sheet; a 10-minute cron imports sheet-minted rows back.
- **Exhibition / In-store billing** (`/admin/exhibition`, `/admin/in-store`) —
  the order-taking wizard:
  - **Sessions** give orders their numbering prefix (`DX-YYYYMMDD-NNN`
    exhibition, `IS-…` in-store) — gapless and race-safe via an atomic
    `next_order_number()` RPC.
  - **Buyer capture** with visiting-card photo (camera *or* gallery), buyer
    search, and per-session recents. Captures made offline queue in IndexedDB
    and replay with idempotency keys.
  - **Continuous QR scanning** into the cart, price-visibility toggle (hide
    wholesale prices while the buyer watches), quantity steppers with MOQ /
    stock warnings that staff can override.
  - **Cart** — per-line ₹/pc price overrides (unpriced ₹0 items are *blocked*
    from finalising until priced), **GST bill-split ×N** (invoice shows one
    piece as N cheaper units; the real count is kept on record as
    `actual_qty`), order-level discount (% or ₹), GST none / 5 / 12 / 18 /
    custom — included in prices or added on top — advance + payment method,
    staff/buyer notes.
  - **Hold / Resume** — park a full order (cart, prices, splits, tax, advance)
    when a buyer steps away and serve the next one; resumable with one tap.
  - **Custom items** — off-catalog pieces with a name, price and photo.
  - **Finalise** → invoice PDF (Royal Noir layout) stored in Supabase and sent
    to the buyer's WhatsApp via Interakt; auto-queued when offline.

### Back office (admins)

- **Dashboard** (`/admin/dashboard`) — money tiles (orders, pieces, sales,
  advance in, balance due) with **Today / 7 Days / All Time** ranges on IST day
  boundaries, plus four breakdowns:
  - **By Product** — real pieces (GST-split aware), line value, order count.
  - **By Vendor** — designs sold, pieces, value per vendor.
  - **By Customer** — orders, pieces, total, advance and balance due, linked
    to the buyer page.
  - **Reorder** — the purchasing table: every product with **vendor name,
    tap-to-copy vendor SKU, last cost price and receipt date** (synced from the
    sheet's procurement columns into an admin-only table — cost prices never
    touch buyer-facing queries), pieces sold, current stock, vendor filter
    chips, search + scan. Sold-out best-sellers surface at the top — exactly
    what to reorder first.
- **Orders** (`/admin/orders`) — search by order number, buyer, phone **or item
  SKU/title** (scanning a garment tag filters to every order containing it),
  Today / 7 Days / All chips, status and source filters, from-date, and an
  on-screen totals line summing whatever is filtered (tap "Today" → the day's
  takings). Columns include Advance and Balance (red when money is owed).
  - **Order detail** — items with zoomable photos, GST-split annotations,
    discount/tax/advance breakdown, status lifecycle (submitted → confirmed →
    fulfilled / cancelled, enforced server-side), Send Invoice.
  - **Modify Order** — a full re-bill: lines edited in **real pieces × real
    price** with a "Bill as ×N" split factor (billed figures derive
    automatically), add items by search/scan, custom lines, **and every billing
    term the cart has** — discount, GST mode/rate, advance, payment method and
    note — pre-filled from the order, recomputed server-side, invoice PDF
    regenerated. Reducing a total below an already-collected advance warns
    about the refund owed.
- **Buyers** (`/admin/buyers`) — sortable/filterable table with WhatsApp links,
  pending-review counter, and add-buyer flow. The buyer page has credential
  management (create / reveal / regenerate / change / share via WhatsApp, all
  audit-logged), status control, order history with lifetime spend, notes,
  activity trail, vCard export, and **Edit Details** — a full profile editor
  (business, owner, phone, city, GSTIN, address, transport, broker, other)
  including **Add/Replace Photo** for the visiting card (camera or gallery,
  zoomable).
- **Manage Catalog** (`/admin/manage-catalog`) — edit any product field
  (title, price, category, colour, fabric, MOQ, stock, restock, description),
  upload/replace photos, hide/show, and rename SKUs. Any manually edited field
  is **locked**: the sheet sync will not overwrite it until it's unlocked from
  the same modal. Renamed SKUs are added to an ignore list so the sheet's old
  row can't resurrect as a duplicate. Scan a tag to jump straight into editing
  that product.
- **Vendors** (`/admin/vendors`) — supplier records (name, phone/WhatsApp,
  city, GSTIN, address, notes) with receipt counts and last-receipt dates;
  scanning a garment tag resolves its vendor (receipt lines first, sheet
  vendor name as fallback). Vendors with receipts deactivate, never delete.
- **Goods Receipts** (`/admin/receipts`) — record-keeping for incoming stock:
  GR-numbered (same atomic counter machinery as orders), vendor + date +
  optional bill photo (private bucket, signed URLs) + bill amount with a
  mismatch badge, lines scanned straight in (repeat scan bumps qty; unknown
  SKUs allowed with a description), full edit/delete with audit trail.
  Phase 1 deliberately writes nothing to product or cost tables — the
  Reorder table shows Last GR Cost/Date *alongside* the sheet columns.
- **Audit Log** (`/admin/audit`) — credential, catalog-edit, vendor and
  receipt events with actor, timestamp, IP.
- **Staff** (`/admin/staff`) — staff accounts and roles (admins manage staff;
  only the super-admin manages admins).

### Buyer portal

Login-gated catalog at wholesale prices with stock states (in stock / limited /
made-to-order / sold out), MOQ rules with "request special quantity", cart, and
order-request submission. Buyers see their order page and receive the invoice /
order-request PDF via WhatsApp. The portal is invisible to the public and
noindexed.

### UX golden rules (applied portal-wide)

1. **Every search has a Scan button** — anywhere you can type a SKU you can
   scan a tag instead.
2. **Every photo is clickable → full-screen zoom** — staff identify garments
   from any thumbnail (shared `Lightbox`/`ZoomImage` components).
3. **Every data table sorts by clicking its column headers** — first click uses
   the column's natural direction (text A→Z, numbers/dates high→low), second
   click flips, blanks sink to the bottom (shared `useSort`/`SortTh`).
4. **Forms stay usable with the keyboard open** — a visual-viewport listener
   (`KeyboardInset`) pads pages and modal sheets past the iOS keyboard; Android
   resizes natively; modals cap height with a dvh + vh fallback for old
   WebViews.

---

## Sync pipeline

The **sole source of truth** is the *Wholesale Drevi Product Master* sheet
(`WHOLESALE_SHEET_ID`, tab `Master`, two-row headers matched by suffix — a
reformatted header doesn't break the sync).

- **Every row with a `Drevi SKU` is included.** Blanks are allowed — a blank
  price stays ₹0 (tags carry the price until the sheet is filled; the wizard
  blocks ₹0 lines until staff set a price), blank restockable on zero stock
  becomes made-to-order so it stays orderable.
- **Products** → `wholesale_products`: title, description, category,
  sub-category, colour, fabric, price (`Final Wholesale`), visibility, MOQ,
  stock, restock. SKUs are canonicalised to uppercase.
- **Procurement + retail** → `product_vendor_info` (separate, admin-read-only
  table — cost prices must never ride along to buyer-facing
  `select("*")` queries): vendor name / ID / SKU, `Last Cost`, last receipt
  date, and `Final MRP` as `retail_price`. Covers *every* sheet row, including
  wholesale-hidden garments (they still hang in the retail shop).
- **Photos** — pulled from a three-source Drive chain: the photos folder
  (`DRIVE_PHOTOS_FOLDER_ID`) → the try-on folder (`DRIVE_TRYON_FOLDER_ID`) →
  the pipeline input root (`DRIVE_INPUT_FOLDER_ID`); within each source:
  exact-SKU folder → colour-only folder → base-design folder → sibling-colour
  folder → loose file. The first source with any photos supplies **all of
  them** (up to 12/SKU, trims warned): copied as ~s800 thumbnails into the
  public `product-photos` bucket at `SKU.ext`, `SKU-2.ext`, … The thumbnail
  (`image_urls[0]`) is the file named like **front**, else the
  lexicographically smallest name. Downloads are all-or-nothing per SKU so a
  transient failure can never shuffle or shrink a good set. Misses retry every
  30 minutes; synced sets re-check their folder weekly (jittered) so added
  shots propagate; fetches are budgeted per run (`DRIVE_IMAGE_BUDGET`) and the
  whole pass stops at a 35s wall-clock deadline so the rest of the sync always
  commits.
- **Manual edits win** — fields locked in Manage Catalog keep their DB value;
  the lock list itself is never clobbered; renamed SKUs are skipped via
  `sync_ignored_skus`; admin-hidden/shown products are never auto-toggled.
- **Guardrails** — a transiently bad sheet that would hide most of the
  storefront skips the hide pass with a loud warning instead; every upsert row
  carries `locked_fields` explicitly (a brand-new SKU must not abort the batch).
- **Triggers** — GitHub Actions cron every 10 minutes
  (`.github/workflows/sync-cron.yml` → `/api/cron/sync-products`, gated by
  `CRON_SECRET`), the Catalog page's **Sync from Sheet** button (full sync),
  and Retail Price Check's **Sync Prices** button (fast, price-only).

## Operations

- **Backups** — hourly GitHub Actions run (`backup.yml`, at :17) exports the
  core tables via `/api/cron/backup` and stores a gzip artifact.
- **Watchdog** — `watchdog.yml` health-checks the deployment every 10 minutes
  with auto-restore.
- **Order numbering** — `next_order_number(prefix, day)` RPC reserves numbers
  atomically (`order_counters`); duplicates are impossible under concurrency.
- **Idempotency** — buyer captures and orders carry client-generated UUIDs
  (`client_ref`); offline replays and double-taps resolve to the existing row
  instead of duplicating.
- **Offline** — the wizard autosaves the working order to localStorage
  (survives refresh/back-swipe), parks held orders per session, and queues
  captures/orders in IndexedDB with a visible retry/discard panel.
- **PDFs** — `@react-pdf/renderer`, offline-safe fonts, paise-aware unit prices
  for GST splits, stored in the private `order-pdfs` bucket, delivered via
  Interakt WhatsApp.

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind (Royal Noir tokens) · Supabase
(Postgres + Auth + RLS + Storage) · `googleapis` (Sheets + Drive) ·
`@react-pdf/renderer` · Interakt (WhatsApp) · Vercel (Hobby) · GitHub Actions
(cron/backup/watchdog).

## Environment

Copy secrets into `.env.local` (gitignored — never commit). The full variable
list and scope is in `CLAUDE.md → Environment variables`; `src/lib/env.ts`
validates required vars at runtime. Highlights:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin client (never shipped to the browser) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Inline JSON **or** a file path; needs Sheets read + Drive read |
| `WHOLESALE_SHEET_ID` | Wholesale Master sheet (defaults to the live sheet) |
| `DRIVE_PHOTOS_FOLDER_ID` | Parent Drive folder of per-SKU photo folders |
| `DRIVE_IMAGE_BUDGET` | Drive photo copies per sync run (default 12) |
| `CRON_SECRET` | Bearer token for `/api/cron/*` |
| `INTERAKT_API_KEY` | WhatsApp sends (portal degrades gracefully without it) |
| `SUPABASE_ACCESS_TOKEN` | Management API token — only for `npm run db:migrate` |
| `SKU_REGISTRY_SHEET_ID` | Legacy SKU registry workbook (importer/mirror/floor) |
| `SKU_REGISTRY_TAB` | Registry tab name (default `SKUs`) |
| `SKU_DUAL_MODE` | `true` during the Apps-Script transition; `false` after retirement |

## Local development

```bash
npm install
npm run dev          # http://localhost:3000  (redirects to /login)
npm run build:local  # production build into .next-build (leaves dev server alone)
```

### Dev environment (safe sandbox)

`npm run dev` runs against the **DEV** Supabase project automatically —
`.env.development.local` (gitignored, dev keys) overrides `.env.local` in dev
mode only, so local experiments never touch production data. `.env.local`
stays pointed at production for builds and the maintenance scripts.

- **Dev database**: Supabase project `qvnvxcdyvcsgxulbcmzm` ("Drevi Wholesale
  DEV") — full schema + a snapshot of prod data (products, buyers, orders,
  registry). Staff logins use the same usernames with the `<name>123`
  convention. Re-snapshot any time by re-running the copy (truncate + insert).
- **Dev deployment**: https://drevi-wholesale-dev.vercel.app — a second Vercel
  project (`drevi-wholesale-dev`) wired to the dev database. Deploy the `dev`
  branch to it with `npx vercel deploy --prod` (the repo is CLI-linked to the
  dev project; the production project still deploys ONLY from pushes to
  `main`, and ignores the `dev` branch via `vercel.json`).
- **Safety rails**: `SKU_MIRROR_DISABLED=true` in both dev environments —
  test mints never append to the real SKU Registry sheet (reads/floors stay
  live). Google Sheets are only ever READ from dev; Drive photos are served
  from prod's public bucket URLs. GitHub Actions crons target production only.
- **Workflow**: branch off `dev`, hack, verify locally or on the dev URL,
  then merge to `main` when it's ready for the real store.

### Database

```bash
npm run db:migrate    # applies supabase/migrations/*.sql via the Management API
npm run db:seed-auth  # dev auth users for the seeded staff + a test buyer
npm run db:backup     # manual backup (same exporter the hourly cron uses)
```

Migrations `0001`–`0014` are idempotent and cover: schema + RLS (`0001`), carts
(`0002`), credentials (`0003`), buyer fields (`0004`), exhibition/sessions
(`0005`), discounts + splits (`0006`), email-unique relaxation (`0007`), atomic
order numbering (`0008`), idempotency keys (`0009`), Manage-Catalog locks +
ignored SKUs (`0010`), vendor/procurement info (`0011`), retail price
(`0012`), SKU registry + atomic `generate_sku` RPC (`0013`), vendors +
goods receipts + audit enum values (`0014`).

### Sync manually

```bash
# dev (no secret, dev only):
curl http://localhost:3000/api/dev/sync-now

# production-equivalent:
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/sync-products
```

Returns `{ synced, image_fetches, hidden, skipped, duration_ms, warnings }`.
(Or just use the **Sync from Sheet** button on the Catalog page.)

## Deploy (Vercel)

1. Import the repo; set every variable from `CLAUDE.md → Environment variables`
   as Vercel project env vars.
2. Scheduling runs on **GitHub Actions** (sync every 10 min, watchdog every
   10 min, backup hourly) hitting the `CRON_SECRET`-gated endpoints — no Vercel
   cron quota needed.
3. Push to `main` → Vercel auto-deploys.

## Troubleshooting

**Sync returns errors / 0 rows:**
- *"required Master columns not found"* — the Wholesale Master is missing one of
  `Drevi SKU`, `Shopify Live URL`, `Wholesale Visible`, `Final Wholesale`
  (headers are suffix-matched; the error lists what it *did* find).
- *Sheets auth error* — `GOOGLE_SERVICE_ACCOUNT_JSON` is wrong, or the service
  account isn't shared on the sheet / Drive folder (Viewer is enough).
- *Photos missing for a SKU* — there is no Drive folder named like the SKU (or
  a sibling colour of the same design). Naming is forgiving: case, spaces and
  hyphens are normalised. Misses retry every 30 minutes.
- *A field keeps reverting after you edit the sheet* — it's **locked** by a
  manual edit; unlock it in Manage Catalog.

**Login fails:**
- Staff: use the shortname (`ansh`) or full email; account must be active.
- Buyer: credentials not yet created (buyer page → Set Credentials), or the
  buyer status isn't `active`.

**An unpriced item blocks Finalise:** intended — set a ₹/pc on the cart line
(one order) or fill the sheet / Manage Catalog price (permanent), then retry.

## Project structure

```
src/
  app/
    admin/             price-check, retail-check, catalog, exhibition, in-store,
                       sku-generator, vendors, receipts, dashboard, orders,
                       buyers, manage-catalog, audit, staff
    (buyer routes)     catalog, cart, product/[sku], order/[id], login, wholesale
    api/               cron (sync, backup, sync-sku-registry), sku/* (generate,
                       state, peek, bases, print-data), drive-photo, orders, health
  components/          QrScanner, Lightbox/ZoomImage, sortable (useSort/SortTh),
                       KeyboardInset, ProductCard/QuickView, OfflineSync, admin/*
  lib/                 sync, sheets, drive, storage, order-pdf, order-finalize,
                       offline (IndexedDB queue), interakt, audit, stock, uuid,
                       supabase/{client,server,admin}
  middleware.ts        auth + status/role gating
supabase/migrations/   0001–0012 (idempotent)
scripts/               apply-migration, seed-auth, backup, probe-sheet
.github/workflows/     sync-cron (10 min), watchdog (10 min), backup (hourly)
```

## License

MIT — see [LICENSE](./LICENSE).
