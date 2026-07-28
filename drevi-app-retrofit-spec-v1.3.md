# DREVI APP — Retrofit Spec
## Receipt-first intake, Studio capture, supplier availability & inventory authority
**Version 1.3 | July 2026 | Hand-off to Claude Code | Internal Document**

**This is the only document you need for this work.** It supersedes and replaces:
- `drevi-app-addendum-1b-receipt-first-intake-v1.md`
- `drevi-app-retrofit-r1-receipt-first-v1.md`
- `drevi-app-retrofit-r8-supply-availability-v1.md`
- any earlier version of this spec (v1.0, v1.1, v1.2)

Discard all of them. The Master Build Guide and Addendum 2B remain as history — they describe what is already built and are not to be re-executed.

**Starting point:** development is complete through **Stage 9** of the Master Build Guide. Migrations `0013`–`0021` are applied. This is a retrofit onto a working system, not new construction.

---

## 0. Protocol

1. Read `CLAUDE.md` and `README.md` first. Every golden rule there still applies: scan button on every search, zoom on every photo, sortable tables, keyboard-safe forms, role gating in middleware, no cost data on buyer-facing or unauthorised surfaces.
2. **Verify before you migrate (§1).** This document states what is believed to be built. If reality differs, stop, record it in `docs/DECISIONS.md`, and adapt — never migrate against an assumed schema on live data.
3. Work through **R0 → R9** (§2.3) in order. One stage per PR. Each ends with its acceptance items passing and `npm run build:local` green.
4. The new intake ships behind **`RECEIPT_INTAKE_V2`** (default `false`). The existing receipt form keeps working until the flag flips in R9. Everything else is additive or backward-compatible.
5. **Parked items** are tagged `ANSH-##`. Do not attempt them. Build to the boundary, stub behind a named flag or disabled UI state, append to `docs/PARKED.md`, continue.
6. Proceed with the defaults here without asking. Deviations get one line in `docs/DECISIONS.md`.
7. New user-facing strings go through `src/lib/strings.ts`. English only.
8. **Assume connectivity.** This portal is used with internet available. Do not design offline paths into new screens. Existing offline machinery (the billing wizard's IndexedDB queue, localStorage draft autosave) stays exactly as it is — draft autosave still protects against refresh, back-swipe and app restart, which is a different problem from being offline.
9. **Regression floor (§12) runs after every stage.** The buyer storefront is live; nothing may change what a buyer currently sees except where §9 explicitly says so.

---

## 1. R0 — Verify the starting state (first PR)

Write `scripts/verify-retrofit-state.ts` that introspects and prints a report, committed to `docs/RETROFIT-BASELINE.md`:

- **Migrations applied** — expect max `0021`. Print actual.
- **Tables present** — `sku_registry`, `vendors`, `goods_receipts`, `goods_receipt_lines`, `designs`, `design_angles`, `image_candidates`, `design_copy`, `publish_targets`, `pipeline_jobs`, `product_images`, `devices`.
- **Row counts** plus: designs by derived state, `design_angles` grouped by `angle`, `image_candidates` grouped by `status`, `publish_targets` grouped by `(portal, state)`, `wholesale_products` with `stock > 0`.
- **Flags** — `SHEET_SYNC_ENABLED`, `SKU_DUAL_MODE`, `SHOPIFY_ENABLED`, `OPENAI_BG_ENABLED`.
- **Legacy Drive** — does `DRIVE_PHOTOS_FOLDER_ID` hold per-SKU folders? How many `image_candidates.file_ref` values resolve to files under the old INPUT / PROCESSED / TRYON folders?

Assumptions this spec is built on:

| # | Assumption | If false |
|---|---|---|
| A1 | Stage 8 cutover complete — `SHEET_SYNC_ENABLED=false`, Supabase is source of truth, `locked_fields` / `sync_ignored_skus` retired | Apply §3.7 interim sync guard |
| A2 | `image_candidates` has `status in ('generated','approved','rejected')`; `design_angles.source_ref` is a text Drive id | Adjust the `0022` backfill |
| A3 | Angle set is `front, back, side, closeup, detail_1, detail_2` | Adjust `0023` |
| A4 | Receipts do not currently write to products | Skip the parts of §5.4 that add it |
| A5 | Buyer storefront is live and reads `product_images` | — (constrains §4.4, §9, §12) |

---

## 2. What changes

### 2.1 The redesign in one paragraph
A design is born from a **goods receipt**, not from the SKU generator or the sheet. The receipt captures vendor, the vendor's own code, the Drevi SKU (minted inline when new), quantity, cost, an **identification photo** of the garment hanging — which creates the design's Drive folder and gives it a real thumbnail from minute one — and the **supplier's availability** for that design. Specs follow, then Studio fills six angles through four input modes with cropping and before/after comparison, then copy. The supplier data drives honest availability and lead times on the wholesale portal.

### 2.2 Before → after

| Area | Built today | After this retrofit |
|---|---|---|
| Design creation | Sheet-sync ingest | Receipt intake; ingest retained for legacy rows |
| Images | `image_candidates` — generated outputs only; source was a text ref on the angle | `design_images` — every image is a row with a role: `ident`, `source`, `candidate`, `import`, `crop` |
| Angles | front, back, side, **closeup**, detail_1, detail_2 | front, back, side, **lifestyle**, detail_1, detail_2 |
| Filling an angle | Generate from source, approve | Four modes: shoot · use input directly · import a finished image · generate |
| Drive layout | INPUT / PROCESSED / TRYON | One folder per design group; legacy registered in place |
| Receipts | Records only; SKU minting and tagging were separate tools | **One "Log delivery" screen** — mint, photograph, count, price, capture supply and queue tags in a single motion; creates designs and folders; writes stock and cost |
| Buyer availability | Derived from our stock alone | Our stock **plus** supplier capability → real ETAs |
| Inventory authority | Ambiguous | **Supabase**, with an append-only movement ledger |

### 2.3 Build order

| Stage | Delivers | Migrations |
|---|---|---|
| **R0** | State verification report | — |
| **R1** | All schema changes | 0022–0026 |
| **R2** | Drive folder helper, ident plumbing, `consolidate_drive` job | — |
| **R3** | Delivery intake — one screen, behind flag: garment capture, inline minting, ident photo, supply panel, tag queue | — |
| **R4** | Specs-only view in Stock; master editor supply fields | — |
| **R5** | Studio four modes, image picker, crop, compare | — |
| **R6** | Vision prompt + model controls | — |
| **R7** | Buyer availability function, labels, firewall test | — |
| **R8** | Stock ledger writes, drift report | — |
| **R9** | Backfill, reconciliation, flip `RECEIPT_INTAKE_V2` | — |

---

## 3. R1 — Schema

Five migrations. Each idempotent, each with its reversal documented in a header comment. `0022` and `0023` touch live rows — read their backfills carefully.

### 3.1 `0022_design_images.sql` — images become first-class

```sql
alter table image_candidates rename to design_images;

alter table design_images add column if not exists role text;
alter table design_images add column if not exists design_id uuid references designs(id) on delete cascade;
alter table design_images add column if not exists derived_from uuid references design_images(id);
alter table design_images add column if not exists file_name text;
alter table design_images alter column angle_id drop not null;

-- design_id was previously reachable only through the angle
update design_images di set design_id = da.design_id
  from design_angles da where da.id = di.angle_id and di.design_id is null;

-- every existing row was a generated output
update design_images set role = 'candidate' where role is null;

-- status: ('generated','approved','rejected') -> ('active','archived','rejected')
-- approval now lives ONLY on design_angles.approved_image_id, never on the image row
update design_images set status = 'active' where status in ('generated','approved');
alter table design_images drop constraint if exists image_candidates_status_check;
alter table design_images add constraint design_images_status_check
  check (status in ('active','archived','rejected'));
alter table design_images add constraint design_images_role_check
  check (role in ('ident','source','candidate','import','crop'));
alter table design_images alter column role set not null;

-- promote the text source_ref into real source rows
alter table design_angles add column if not exists source_image_id uuid references design_images(id);
insert into design_images (design_id, angle_id, role, file_ref, status, created_by, created_at)
select da.design_id, da.id, 'source', da.source_ref, 'active', 'retrofit', now()
  from design_angles da
 where coalesce(da.source_ref,'') <> ''
   and not exists (select 1 from design_images d where d.angle_id = da.id and d.role = 'source');
update design_angles da set source_image_id = d.id
  from design_images d
 where d.angle_id = da.id and d.role = 'source' and da.source_image_id is null;

alter table design_angles rename column approved_candidate_id to approved_image_id;

create index if not exists di_design_role_idx  on design_images (design_id, role);
create index if not exists di_angle_created_idx on design_images (angle_id, created_at desc);
```

Keep `design_angles.source_ref` for one release as a read-only fallback; drop it once R9's reconciliation is clean.

Update every reference in `src/` **and** `pipeline/` — the runner registers candidates here, so `pipeline/drevi_common.py` needs the new table name, `role='candidate'`, and `design_id` populated on insert. Verify the RLS policies survived the rename (policy names may reference the old table); buyers and anon stay denied.

### 3.2 `0023_angles_lifestyle.sql` — closeup becomes lifestyle

A closeup is not a lifestyle shot, so this is **not** a rename. Existing closeup images are preserved as design-level images, selectable for any angle in the new picker.

```sql
alter table design_angles drop constraint if exists design_angles_angle_check;
alter table design_angles add constraint design_angles_angle_check
  check (angle in ('front','back','side','lifestyle','closeup','detail_1','detail_2'));

-- detach images from closeup angles; they survive as design-level images
update design_images set angle_id = null
 where angle_id in (select id from design_angles where angle = 'closeup');

delete from design_angles where angle = 'closeup';

insert into design_angles (design_id, angle)
select id, 'lifestyle' from designs
on conflict (design_id, angle) do nothing;

alter table design_angles drop constraint design_angles_angle_check;
alter table design_angles add constraint design_angles_angle_check
  check (angle in ('front','back','side','lifestyle','detail_1','detail_2'));
```

Print how many closeup images were detached, so Ansh knows how much material moved into the design-level pool.

### 3.3 `0024_receipt_intake.sql` — receipts, designs, provenance

```sql
alter table goods_receipts add column if not exists entry_date date;
update goods_receipts set entry_date = (created_at at time zone 'Asia/Kolkata')::date
 where entry_date is null;
alter table goods_receipts alter column entry_date set not null;
alter table goods_receipts alter column entry_date
  set default (now() at time zone 'Asia/Kolkata')::date;

alter table goods_receipt_lines add column if not exists vendor_sku text;
alter table goods_receipt_lines add column if not exists design_id uuid references designs(id);
alter table goods_receipt_lines add column if not exists created_design boolean not null default false;

alter table designs add column if not exists origin text not null default 'sheet'
  check (origin in ('sheet','app'));
alter table designs add column if not exists drive_folder_id text;
alter table designs add column if not exists ident_image_id uuid references design_images(id);
alter table designs add column if not exists vendor_id uuid references vendors(id);
alter table designs add column if not exists vendor_sku text;
alter table designs add column if not exists first_receipt_id uuid references goods_receipts(id);

create index if not exists grl_design_idx on goods_receipt_lines (design_id);
```

**Backfills, best effort and logged:** link existing receipt lines to designs by parsing `upper(sku)` into `(base, colour)`; set `designs.vendor_id` / `vendor_sku` from the most recent linked line, falling back to a normalised name match against `product_vendor_info`. Report unmatched counts. Do not guess.

`entry_date` is immutable after insert — enforce in the API, not a trigger. `receipt_date` stays editable and defaults to `entry_date`.

### 3.4 `0025_supply_availability.sql` — supplier capability

```sql
-- current truth, on the design
alter table designs add column if not exists supply_mode text
  check (supply_mode in ('ready_stock','made_to_order','both','discontinued'));
alter table designs add column if not exists vendor_stock_qty int check (vendor_stock_qty >= 0);
alter table designs add column if not exists making_days      int check (making_days      >= 0);
alter table designs add column if not exists making_moq       int check (making_moq       >  0);
alter table designs add column if not exists delivery_days    int check (delivery_days    >= 0);
alter table designs add column if not exists supply_note text;
alter table designs add column if not exists supply_updated_at timestamptz;
alter table designs add column if not exists supply_updated_by text;

-- the same set as a dated observation, for history
alter table goods_receipt_lines add column if not exists supply_mode text;
alter table goods_receipt_lines add column if not exists vendor_stock_qty int;
alter table goods_receipt_lines add column if not exists making_days int;
alter table goods_receipt_lines add column if not exists making_moq int;
alter table goods_receipt_lines add column if not exists delivery_days int;
alter table goods_receipt_lines add column if not exists supply_note text;
```

Field meanings — use this wording in the UI, it is what Arushi will actually ask the vendor:

| Field | Question | Notes |
|---|---|---|
| `supply_mode` | Do they keep this in stock, make it to order, or both? | `discontinued` = they've stopped it |
| `vendor_stock_qty` | Roughly how many do they have ready? | Approximate is fine; breaks the `both` tie |
| `making_days` | If we order, how many days to make it? | Production only |
| `making_moq` | Minimum pieces they'll make in one run? | **Internal — never shown to buyers (§9.2)** |
| `delivery_days` | How long to reach us once ready? | Transit only, kept separate from making |
| `supply_note` | Anything else | e.g. "teal only, red discontinued" |

All optional. A design with nothing recorded behaves exactly as it does today.

### 3.5 `0026_stock_ledger.sql` — movements with resettable baselines

Stock history has a hole: goods **in** are knowable from receipts, but there are no reliable per-SKU **sale** records for the past. So the ledger must support a **baseline reset** — "as of now this SKU is N pieces, ignore everything before" — and all arithmetic runs forward from the most recent baseline.

```sql
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  sku text not null,                          -- variant SKU, uppercase
  delta int not null default 0,               -- +in / -out; ignored when reason='reset'
  snapshot_qty int,                           -- absolute count; required when reason='reset'
  reason text not null check (reason in
    ('reset','receipt','order','manual','correction','shopify_sync')),
  ref_type text, ref_id uuid,                 -- receipt line id, order id, …
  note text, created_by text,
  created_at timestamptz not null default now(),
  constraint sm_reset_shape check (
    (reason = 'reset' and snapshot_qty is not null) or
    (reason <> 'reset' and snapshot_qty is null)
  )
);
create index if not exists sm_sku_idx on stock_movements (upper(sku), created_at desc);
```

**Canonical stock for a SKU** — implement once, in `src/lib/stock-ledger.ts`, and use it everywhere:

```
latest reset R for the SKU (by created_at)
stock = R.snapshot_qty + Σ(delta) for movements where created_at > R.created_at
      (no reset yet → Σ(delta) over all movements)
```

The migration seeds one `reset` per SKU at its current `wholesale_products.stock`, note `migration opening balance`, so the ledger starts reconciled and nothing earlier is implied.

`wholesale_products.stock` stays the fast cached read; every mutation writes a movement in the same transaction (§10).

### 3.6 Env additions
`RECEIPT_INTAKE_V2` (default `false`), `DRIVE_DESIGN_FOLDER_ID` (**empty by default — Ansh supplies it later, see §4**), `HANDLING_DAYS` (2), `AVAILABILITY_BUFFER_DAYS` (3), `LIMITED_THRESHOLD` (5), `SUPPLY_STALE_DAYS` (60). Register in `src/lib/env.ts` and document in `CLAUDE.md`.

`SKU_DUAL_MODE` already exists and **stays `true` permanently** — it is no longer a transition flag but the mechanism that keeps the registry sheet integrated (§5.12). Update its description in `CLAUDE.md` accordingly.

### 3.7 Interim sync guard — only if A1 is false
If `SHEET_SYNC_ENABLED` is still `true` in any environment, the product sync must skip `origin='app'` designs entirely — never hide, overwrite, or delete them, since they legitimately have no sheet row. Add the guard beside the existing ignore logic and delete it when the cutover flag flips.

---

## 4. R2 — Drive storage: one folder per design

**Decision: one folder per design group** (`base_sku` + colour), replacing the INPUT / PROCESSED / TRYON split. The app is now the index — role, engine, status and approval all live in `design_images` — so the folder no longer has to carry meaning, and Arushi navigates one place per garment instead of two.

### 4.1 The parent folder comes from env, and may be empty

The parent is **`DRIVE_DESIGN_FOLDER_ID`**. It ships **empty**: Ansh is manually consolidating each SKU's photos across the existing folders first and will supply the id afterwards (**ANSH-19**).

**Behaviour while it is empty — no crashes, no mess:**
- `ensureDesignFolder()` returns null; **no folder is ever created** under a guessed parent.
- Every image-upload path (ident photo, mode A shoot/upload, mode C import, crops) is **disabled with a clear inline message**: "Drive photo folder not configured yet." Receipts, SKU minting, supply capture, specs, copy, publishing of already-known images, and everything else continue to work normally.
- Log once at startup at warn level. Surface it as a single admin banner on the Studio board — not a toast on every screen.

Do not fall back to the legacy INPUT folder. A silent fallback would scatter new files into the very folders being consolidated.

### 4.2 Layout and naming for new files

```
<DRIVE_DESIGN_FOLDER_ID>/
  DD-LEH-MRM-007-TLG/
    ident.jpg
    front__src__01.jpg          front__fashn__01.jpg
    back__src__01.jpg           back__fashn__02.jpg
    front__src__01__crop1.jpg
    lifestyle__fashn__01.jpg
    detail1__src__01.jpg
    _archive/                   demoted or rejected images
```

Naming for **files the app creates**: `<angle>__<src|import|engine>__<NN>[__cropN].<ext>`, lowercase, `NN` increments per (angle, source-kind). Never overwrite a filename. `ident.jpg` is the one fixed name; replacing it moves the previous to `_archive/ident__prevNN.jpg`.

**Files Ansh consolidated by hand keep whatever names they have.** Do not rename, move, or reorganise existing files — the database is the index, mixed naming inside a folder is expected and fine.

### 4.3 Folder matching — audit before creating anything

Consolidated folders may be named `DD-LEH-MRM-007`, `DD-LEH-MRM-007-M-TLG`, or the group name `DD-LEH-MRM-007-TLG`. Blind exact-name lookup would create duplicates beside real work.

`ensureDesignFolder()` resolves in this order, mirroring the existing photo-sync fallback: **exact group name** → **base-SKU folder** → **any variant-SKU folder of that group** (single match only). Ambiguous matches are never guessed — they are reported and skipped. Only after all three miss does it create the group-named folder, and only when `DRIVE_DESIGN_FOLDER_ID` is set.

Ship `scripts/drive-folder-audit.ts` (admin-run, read-only) writing `docs/DRIVE-FOLDER-AUDIT.md`:
- designs matched to exactly one folder, and by which rule;
- designs matched ambiguously (list the candidates);
- designs with no folder;
- folders under the parent matching no design.

**Run this and clear it before the first upload.** It exists so Ansh can rename a handful of folders instead of discovering duplicates later.

### 4.4 Legacy files stay registered where they are

Drive file ids are stable across folders, so every `file_ref` registered by the Stage 4 `scan_drive` job keeps resolving no matter where the file sits — including after Ansh moves it by hand. **The app performs no migration and moves nothing.**

Replace any planned file-moving job with a **read-only mapping report**, `scripts/drive-map-report.ts` → `docs/DRIVE-MAP.md`: for every design, list its registered files with their current parent folder, name, and role. This is a direct aid to the manual consolidation — it tells Ansh exactly which scattered files belong to which SKU.

### 4.5 Other rules
- The app **never deletes** from Drive. Demotion and rejection move files to `_archive/`.
- AI outputs keep the IPTC `CompositeSynthetic` tag the pipeline already writes.
- Published images continue to be copied into the `product-images` bucket at publish time. Drive is the working set; Supabase Storage is the published set.

### 4.6 Ident photos are internal-only
An identification photo is a garment on a hanger — useful for staff, wrong for a storefront. It must **never** reach `product_images`, the publish gates, or any buyer-facing response. Assert in the publish routine and in a test; the buyer storefront is live.

Where it *does* appear: Studio board thumbnails, workbench header, receipt line confirmation, price-check and catalog for staff-side garment identification, and the Studio image picker as a selectable source.

---

## 5. R3 — Delivery intake: one screen (behind `RECEIPT_INTAKE_V2`)

### 5.1 Why one screen
Minting a SKU, logging the line, and photographing the piece are not three tasks — they are one physical motion performed with a garment in hand at the delivery table. Building them as three tools guarantees re-keying and lost context. **The unit of work is the garment, not the receipt line.**

Route stays `/admin/receipts/new`, titled **"Log delivery"**. The existing form remains reachable until the flag flips in R9.

### 5.2 The screen

1. **Vendor & dates** — vendor picker with search and inline **"+ New vendor"** (name + phone, saves and selects without leaving the screen); receipt date (defaults to today IST, editable — the date on the vendor's bill); entry date (today, read-only, small); optional bill photo and bill amount. Once set, this whole block **collapses to a one-line summary chip** and stays out of the way.
2. **Garments** — a list of captured cards, **one card per design, not per size**. Each shows: ident thumbnail · SKU (mono) · name/colour · sizes as `M×2 · L×3` · unit cost · a supply badge · a tag-count chip. Tap to reopen, swipe or menu to remove.
3. **+ Add garment** — the primary action, large, always reachable at the bottom of the list.
4. **Footer** — running totals (designs · pieces · value), mismatch badge against `bill_amount` when set, and the primary **Save & print tags**.

### 5.3 The garment capture sheet
Opens full-screen over the list — one garment at a time, big targets, one-handed. Four sections stacked top to bottom, all visible, no forced wizard steps so an experienced user can move fast:

**a. Identify.** Three entry points side by side: **Scan tag** · **New design** · **Search**.
- Scan or search resolving to a known design → **reorder path** (§5.5).
- **New design** opens the mint panel: category → sub-category → colour, with the next number previewed live. The SKU is minted through the existing `generate_sku` RPC the moment the first size is chosen in section (c) — never as a separate errand.

**b. Photo.** A large camera tile: one shot of the garment hanging, which becomes the design's `ident.jpg` (§4.6). Shows the captured image immediately with the SKU overlaid — the confirmation that this picture is now bound to this code. On a reorder it shows the existing photo with a small **Replace** action. Skippable; skipping flags the design "No ident photo".

**c. Sizes & cost.** Size chips (from the size vocabulary) with **quantity steppers** — tap `M`, set 2; tap `L`, set 3 — plus **unit cost** and **vendor SKU** for the design. This section is what turns one garment into several receipt lines (§5.4).

**d. Supplier availability.** Collapsible, the six fields from §3.4 worded as the questions in that table. Pre-filled with current values on a reorder so Arushi confirms rather than retypes. Skippable.

Footer: **Add to delivery** → the sheet closes and a card appears in the list.

### 5.4 Sizes nest inside the garment
One capture = one design = **N receipt lines**, one per size, generated on add. The design group, ident photo, supply block and vendor SKU are captured **once** and shared by every line.

Minting for a new design follows the size list automatically: the first size mints the base and its variant, each further size mints a variant of that same base. Arushi never chooses "new design or variant" — the app knows.

### 5.5 Reorder path
A resolved design collapses the work: the card shows its ident photo, title and colour for visual confirmation ("this one?"), photo and supply are pre-filled, and only **sizes, quantities, cost and vendor SKU** need attention. Supply is re-prompted, expanded, only when `supply_updated_at` is older than `SUPPLY_STALE_DAYS`.

### 5.6 Tags come out of the same motion
Every variant SKU captured on the delivery is **auto-queued into the existing label print tray**, with the count shown on each garment card and in the footer. **Save & print tags** saves the receipt and goes straight to the print sheet with exactly this delivery's SKUs staged — the roll-label PDF path is unchanged. A secondary **Save only** exists for when tags are printed later.

### 5.7 On save
Per garment: upsert the design group (`origin='app'`, `first_receipt_id`, `vendor_id`, `vendor_sku`), ensure the six `design_angles` rows exist, write the ident image row and `drive_folder_id` when a photo was taken, apply the supply block per §5.9. Per size: one `goods_receipt_lines` row with `design_id` and `created_design`. Then mint the GR number via the existing `next_order_number('GR', day)` RPC and write audit entries.

**Stock and cost:** receipts set `last_cost` and **increment stock** for the received variants, writing a `receipt` movement per §10. The master editor can still override; when it does, the audit entry records "manual stock adjustment after GR-…". Lifting the earlier prohibition on receipts writing to products is deliberate and safe post-cutover.

### 5.8 Connectivity
Assume internet. The draft autosaves locally so a refresh, back-swipe or app restart never loses a half-captured delivery, but there are **no offline capture paths** in this screen: minting, photo upload and save all go straight to the server. Do not build a queue, do not disable controls for signal, and never invent a SKU locally.

If a request fails, surface a plain retry on the affected garment rather than degrading the whole screen.

### 5.9 Supply write rule
Saving a supply block updates the design's current values plus `supply_updated_at` / `supply_updated_by`, and leaves the dated observation on **each** receipt line generated from that garment. Blank fields on an observation **do not** wipe existing design values; only supplied fields overwrite.

### 5.10 The standalone SKU generator stays, reframed
`/admin/sku-generator` keeps every capability — minting, QR lookup, the print tray, roll-label PDFs, calibration. But since minting now happens inside delivery intake, its role is **labels first**: lead the screen with the print tray and reprint flows, and demote standalone minting to a secondary action for the rare cases (a garment that arrived without a receipt, a lost tag being reprinted). Do not remove anything. In the Stock space, **"Log delivery" becomes the primary entry** and "SKU & labels" sits below it.

### 5.11 Shop-device note
Delivery intake sits in the Stock space, inside `floor` scope, so Arushi can log deliveries on the shared counter device. The full master editor stays out of floor scope because it exposes cost — hence §6.2.

### 5.12 The SKU registry sheet stays integrated — permanently

The Google registry sheet (`SKU_REGISTRY_SHEET_ID`, tab `SKUs`) is **not transitional scaffolding to be retired**. It remains a live, complete record of every SKU ever minted, written through on every mint, exactly as the current SKU generator behaves.

**Why Supabase still holds the authoritative registry:** the app resolves SKUs live while Arushi types, joins the registry to designs, receipts and print data, and enforces access through RLS. Sheet reads are far too slow and quota-bound for that. So Supabase is the working registry and the sheet is a synchronous mirror of it — the same relationship a database and its audit log have.

**Why this cannot produce duplicate SKUs.** Duplicates require two systems independently computing the next number. Here:
- The portal is the sole minting authority. `generate_sku` takes a transaction-scoped advisory lock on `(category, sub_category)`, so concurrent mints in the same category serialise rather than collide.
- The unique index on `upper(variant_sku)` is the backstop beneath that.
- The sheet receives a copy of the minted row. A record cannot mint anything, so it cannot collide with anything.

**Keep `SKU_DUAL_MODE=true` permanently**, reframed from a transition flag to **sheet-integrated mode**. It does two things, both worth keeping forever:
1. **Floor read before minting** — a ranged read of column B, filtered to `DD-{cat}-{sub}-`, taking the maximum. The portal never mints at or below that number. This is what makes it safe for the legacy Apps Script tool to keep running: even if someone mints there, the portal sees it and steps past it.
2. **Write-through after minting** — append columns A–I to the sheet inside the same request, then mark `sheet_synced=true`.

Column J (`QR Code`) is left blank for portal-minted rows and existing values are never touched — QR codes are deterministic from the SKU string and generated on demand, so nothing needs storing.

**If the sheet append fails** (a Google API blip), the SKU is still returned and the work continues — the row stays `sheet_synced=false`, the existing cron retries it on the next pass, and the Studio board and delivery screen show a small **"registry sync pending"** indicator until it clears. The importer continues to reconcile anything minted outside the portal. Minting must never be blocked by the sheet being briefly unavailable.

---

## 6. R4 — Specs hand-off

### 6.1 Master editor
A receipt-created design lands at **Awaiting specs**, pre-filled with SKU, vendor, vendor SKU, last cost, ident photo and any supply data. Rakesh fills colour (when not derivable from the SKU), fabric, handwork, origin, retail price override, wholesale price override, then flips **`specs_verified`**. Auto-MRP and override behaviour are unchanged. `specs_verified=false` continues to block copy generation. Add the supply block here too.

### 6.2 New: specs-only view inside Stock
The full master editor shows cost prices, so it cannot be in floor scope — which means Rakesh cannot fill specs on the shared counter device. Add `/admin/specs/[designId]` in the **Stock** space (floor scope, admin role): ident photo, SKU, and descriptive fields only — fabric, handwork, origin, colour, the **supplier availability block**, and the `specs_verified` toggle. **No pricing fields, no cost, no vendor cost data.** None of the supply fields are cost data, so they are safe here. This is the screen Rakesh actually uses, since he owns the vendor relationships; the full editor remains for pricing on his own device.

### 6.3 Cockpit additions
Three inbox items: **"N designs awaiting specs"** (Rakesh's queue, Arushi co-owner per the working pattern), **"N designs without an ident photo"**, and **"N made-to-order designs with supply info older than `SUPPLY_STALE_DAYS`"** (§9.4).

---

## 7. R5 — Studio: four input modes, crop, compare

### 7.1 Four modes per angle

| Mode | Action | Result |
|---|---|---|
| **A · Shoot / upload** | Camera or gallery | New `role='source'` image → `<angle>__src__NN`; becomes the angle's `source_image_id` |
| **B · Use an input directly** | Pick an existing source or ident image | Sets it as source **and** approved image, `engine='raw'`. No generation, no cost |
| **C · Import a finished image** | Upload an externally-edited final | `role='import'`, immediately approvable — covers Canva / Photoshop / phone edits |
| **D · Generate** | Pick a source, engine and prompt | Dispatches a pipeline job → `role='candidate'` for review |

Mode D controls sit on the card **before** firing: engine chips (`fashn` · `openai_bg` · `raw` · `seedream` disabled), an editable prompt pre-filled from the design's specs (editing sets `prompt_edited_by_human`, so nothing regenerates over it), and the credit estimate on the Generate button.

**Processing is uniform: neutral grey studio background on every processed angle.** No tier-based treatment, no scene composition, no per-design background choice. `front`, `back`, `side` and `lifestyle` are all AI-eligible and all produced on the same grey studio background.

- **`lifestyle` is a slot, not a scene.** It keeps its name and its place in the set of six so composed backgrounds can arrive later without a migration, but for now it is processed exactly like the other model angles — grey background, same default prompt shape, differing only in framing.
- **`openai_bg` means "normalise the background to neutral grey"** — the useful job when Arushi shoots a mannequin against shop clutter. Its default prompt is a background normalisation, not a scene.
- **`detail_1` and `detail_2` are macro shots and are never processed at all.** They accept modes A, B, C only — never D. Enforce in UI **and** API: generative try-on re-synthesises embroidery and would destroy the handwork. They keep whatever background they were shot on.

There is no tier branching anywhere in the photo pipeline. `tier` survives only as a copy-model hint (§8).

### 7.2 Image picker
One sheet listing every `design_images` row for the design, grouped by role, with thumbnail, engine badge and date — including the ident photo and any images detached from closeup angles by `0023`. Archived images behind a toggle. Used by modes B and C and by "change source" on mode D.

### 7.3 Crop
Available on **any** image, before generating or after. Presets **4:5** (model shots), **1:1** (Google Shopping), free. Client-side crop uploads a new `role='crop'` row with `derived_from` set. Originals are never modified, and a crop is selectable anywhere its parent was.

### 7.4 Compare
On any angle holding both a source and a candidate: **side-by-side** (default) and **slider overlay**, synced pinch-zoom, full-screen mode. This is the judgement surface for AI fidelity — make it fast and obvious. Both images stay individually zoomable.

### 7.5 Approve / reject
Approve sets `approved_image_id` and moves prior candidates to `_archive/`; reject sets `status='rejected'`; any approval on a design already live on a portal flips that portal to `changes_pending` with a visible Re-push action. Never auto-push.

---

## 8. R6 — Vision controls

The copy track keeps its position as an independent track runnable before or after photos. Two additions:

1. **Editable prompt** in the copy panel, pre-filled from specs and approved images, persisted per design.
2. **Model selector** — default `claude-sonnet-4-6`, hero tier `claude-opus-4-8`, dropdown ready for future options. Cost estimate before running.

Since angle prompts are authored in Studio, vision's job here is **name, description and tags** only. `specs_verified=false` still blocks generation and batch runs skip-and-report.

---

## 9. R7 — Buyer availability

### 9.1 One pure function
Create `src/lib/availability.ts` as the single implementation. Buyer cards, product pages, cart, and admin previews all call it — no second copy anywhere.

```ts
computeAvailability({ ourStock, restockable, supply, buyerMoq, handlingDays, bufferDays })
  → { state, label, etaDays?, orderable, remaining? }
```

| State | When | Buyer sees |
|---|---|---|
| `in_stock` | `ourStock >= buyerMoq` | "In stock" |
| `limited` | `0 < ourStock < LIMITED_THRESHOLD` | "Limited · N left" |
| `on_order_ready` | `ourStock = 0`, mode `ready_stock`/`both` with `vendor_stock_qty > 0` | "Available on order · ~X days" |
| `made_to_order` | `ourStock = 0`, mode `made_to_order`/`both` | "Made to order · ~X days" |
| `sold_out` | `ourStock = 0`, no usable supply data | "Sold out" + Notify me |
| `discontinued` | mode `discontinued` | "No longer available", not orderable |

ETA arithmetic:
- `on_order_ready` → `delivery_days + handlingDays + bufferDays`
- `made_to_order` → `making_days + delivery_days + handlingDays + bufferDays`
- `both` prefers the ready-stock path (faster) when `vendor_stock_qty > 0`
- **Any required input missing → drop the ETA and show the label without days.** Never render a number you cannot support.

Always approximate ("~18 days"), never a hard date. Buffer and handling are env config (§3.6) so promises are tuned without a deploy.

### 9.2 Firewall — what may cross to a buyer
The object in any buyer-facing response contains **only** `state`, `label`, `etaDays`, `orderable`, and `remaining` for `limited`. It must never contain, or allow derivation of, the vendor's name or SKU, `vendor_stock_qty`, `making_moq`, `making_days` / `delivery_days` as separate values, cost, or `supply_note`.

`making_moq` is deliberately internal: it informs **Rakesh's** choice of buyer MOQ for that design and is never a message to a buyer. If a vendor's minimum run should be passed on, Rakesh raises the buyer MOQ — the existing, visible field.

Assert with a test that serialises a buyer product response and fails on any supply field beyond the five allowed keys, in the same spirit as the existing cost-leak tests.

### 9.3 Order review — production MOQ flag (admin only)
On the order review screen, flag any line where the design has `ourStock = 0`, a made-to-order path, and `qty < making_moq`:

> **Below vendor production minimum** — order is 3 pcs, vendor makes minimum 10. Aggregate with other orders or absorb 7.

Decision support only; it never blocks confirmation. This is the real commercial choice the data exists to surface.

### 9.4 Staleness
Quoting a stale lead time is how a promise breaks. Show `supply_updated_at` as relative age next to the block wherever it appears ("updated 3 weeks ago"), and add the cockpit item from §6.3 deep-linking to the board filtered to those designs. Designs with our own stock are excluded — their ETA isn't being used.

---

## 10. R8 — Inventory: Supabase is the source of truth

**Decision: Supabase is authoritative for inventory.** Receipts increment, orders decrement, the master editor corrects.

**The honest gap:** until a Shopify sync exists, any sale completed outside this app — retail through Shopify POS — is invisible here, so Supabase stock will read **high**, and a wrong "In stock" on the portal is precisely the inaccuracy this work exists to remove. Do not paper over it; make it visible and reconcilable.

### 10.1 Write movements everywhere stock changes
Every mutation writes a `stock_movements` row (§3.5) in the same transaction as the `wholesale_products.stock` update: receipt save → `receipt`; order finalise → `order`; master-editor edit → `manual` (note required); reconciliation → `correction`. A future Shopify sync writes `shopify_sync` — which is the entire reason for building the ledger now: a movement log can be reconciled event by event, two disagreeing integers cannot.

`wholesale_products.stock` is updated to the value the canonical function in §3.5 returns — never incremented blindly — so the cache can never drift from the ledger.

### 10.2 Stock override — the answer to missing sales history

Goods **in** are knowable from receipts, but per-SKU **sale** history for the past does not exist, so no amount of arithmetic over receipts can produce today's true stock. Staff must be able to declare it.

**A `reset` movement is that declaration.** It records an absolute counted quantity and makes everything before it irrelevant: the canonical calculation starts from the most recent reset and adds only later movements. Nothing is deleted — earlier movements remain visible as history, they simply stop contributing.

Two places to write one:

**a. Single SKU** — "Set stock" on the master editor and on the drift report: enter the counted quantity, a required note, save. Writes `reason='reset'`, `snapshot_qty=<count>`, audit-logged with the actor.

**b. Stock take** — a new `/admin/stock-take` screen in the **Stock** space (floor scope, admin role), built for walking the rack: **scan a tag → the SKU and its current system quantity appear → type the counted quantity → next**. Scanning the same tag again returns to that line rather than duplicating it. A running list shows counted SKUs with their variance (system vs counted), and **Commit** writes one `reset` per counted SKU in a single transaction with a shared session note ("stock take 28 Jul"). Uncounted SKUs are left completely untouched — a partial stock take is normal and must never zero anything by omission.

Both paths make it explicit in the UI that a reset **supersedes earlier receipt-derived arithmetic** for that SKU.

### 10.3 Drift report
`/api/admin/stock-reconcile` (admin+) compares the canonical ledger value against `wholesale_products.stock` per SKU and lists mismatches with each SKU's last five movements and the date of its most recent reset. Surface on the dashboard as **"N SKUs need a stock check"**. Every row offers two actions: **Recompute cache** (cache was stale) and **Set stock** (reality differs — writes a reset). Corrections are always logged movements, never silent overwrites.

### 10.4 Parked
**ANSH-18 — Shopify inventory sync:** direction, cadence, and which system wins a conflict. The ledger and the reset mechanism are its foundation. Until it ships, expect Supabase to read **high** for anything sold through Shopify POS, and correct it with a stock take rather than trusting the number blindly.

---

## 11. R9 — Backfill, reconciliation, flag flip

Output to `docs/RETROFIT-RECONCILIATION.md`:

- **Folders** — create the per-design folder for every design holding any image or receipt line; report designs with none.
- **Ident photos** — list designs without one, grouped by whether they already have an approved image (a published design is lower priority than a fresh one).
- **Source rows** — confirm every angle that had a legacy `source_ref` now has a matching `design_images` row and `source_image_id`; report mismatches before `source_ref` is dropped.
- **Lifestyle** — confirm every design has a lifestyle angle row; report how many closeup images were detached and remain unassigned.
- **Receipt links** — report receipt lines whose SKU didn't resolve to a design.
- **Ledger** — confirm `sum(delta)` equals `stock` for every SKU.
- **Buyer safety** — assert no `role='ident'` image appears in `product_images` or any buyer response.

Then flip `RECEIPT_INTAKE_V2=true` and retire the old receipt form in a follow-up PR once a week of real use is clean.

---

## 12. Regression floor — run after every stage

Because the buyer storefront is live:

- Buyer login → storefront home renders → reorder rail correct → product page gallery unchanged → cart → submit order request.
- A published design's images are byte-identical before and after the migrations.
- Staff: retail-check, exhibition billing finalise → PDF, price-check, label print with price, orders list, dashboard tiles.
- Shop device: PIN unlock → billing → receipt entry works, and `/admin/dashboard` is still refused.
- Pipeline: dispatch one FASHN job end-to-end; progress streams; the candidate registers against `design_images`.
- SKU registry: mint one SKU; confirm it lands in Supabase and in the sheet, and that the floor read still returns the correct next number.
- Backups, watchdog and cron workflows untouched and passing.

---

## 13. Acceptance

0. **With `DRIVE_DESIGN_FOLDER_ID` empty:** receipts, minting, supply capture, specs, copy and publishing all work; every image-upload control is disabled with the configured message; no folder is created anywhere; `drive-folder-audit` and `drive-map-report` both run and produce their documents.
1. **Thread test, receipt-first (folder id set):** a brand-new design is entered from one screen — vendor → vendor SKU → mint Drevi SKU inline → qty and cost → ident photo → supplier availability → save. It appears on the board with its photo at `Awaiting specs`, its Drive folder exists containing `ident.jpg`, Rakesh completes specs and supply from the Stock specs view on the counter device, Arushi fills all six angles using at least one of each mode, copy generates and is approved, wholesale publishes, and the buyer sees it — with the ident photo nowhere in the buyer's gallery.
2. A reorder line resolves to the existing design, shows its ident photo, pre-fills supply values, creates no folder, and updates cost and stock.
3. One garment captured as `M×2 · L×3` produces **one** design group, one folder, one ident photo, one supply block and **two** receipt lines; the M variant mints the base and the L variant mints against that same base without Arushi choosing a mode.
3a. Every variant from the delivery is queued in the print tray, and **Save & print tags** lands on the print sheet with exactly those SKUs staged.
3b. Every SKU minted during a delivery appears as a row in the registry sheet **within the same request**, and the portal's own registry and the sheet agree afterwards.
3c. With a number present only in the sheet for a given category, the next portal mint lands above it — the floor read holds.
4. Modes B and C cost zero credits; detail angles reject mode D at the API, not just the UI; every processed angle comes back on neutral grey with no tier branching anywhere in the path.
5. A crop leaves its original intact and is selectable as both source and final.
6. A zero-stock `made_to_order` design with `making_days=12`, `delivery_days=3` shows a buyer "Made to order · ~20 days" at default handling and buffer, and is orderable. Removing `making_days` yields the label with **no** day count anywhere.
7. A serialised buyer product response contains no vendor name, vendor SKU, vendor stock, production MOQ, or note — enforced by test.
8. An order line below the vendor's production minimum raises the admin flag and still confirms normally.
9. The canonical ledger value equals `wholesale_products.stock` for every SKU after `0026`; a receipt and an order each add exactly one movement; the drift report reads zero.
9a. A `reset` of 12 on a SKU with prior receipt movements yields exactly 12; a later receipt of 3 yields 15; earlier movements remain visible but do not contribute.
9b. A partial stock take commits resets only for scanned SKUs and leaves every other SKU's quantity unchanged.
10. Designs with no supply data behave exactly as before this retrofit.
11. Every migration re-runs clean; `RETROFIT-RECONCILIATION.md` has no unexplained mismatches.
12. `RECEIPT_INTAKE_V2=false` restores the previous receipt form with no errors.

---

## 14. Parked ledger (`docs/PARKED.md`)

| ID | Status | What Ansh does | Unblocks |
|---|---|---|---|
| ANSH-14 | **Closed** | Wholesale columns defined | §3.4 |
| ANSH-15 | **Closed** | Uniform neutral grey on all processed angles; no tier treatment | §7.1 |
| ANSH-16 | **Closed** | Supabase is inventory source of truth | §10 |
| ANSH-17 | **Closed** | Superseded — the app moves no files; `drive-map-report` assists manual consolidation | §4.4 |
| ANSH-18 | **New** | Shopify inventory sync: direction, cadence, conflict rule | Removes the §10 drift gap |
| ANSH-19 | **New** | Consolidate each SKU's photos into per-design folders, clear the folder audit, then supply `DRIVE_DESIGN_FOLDER_ID` | All image upload paths (§4.1) |
