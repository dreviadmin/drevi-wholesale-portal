# DREVI APP — Master Build Guide
## From the live Wholesale Portal to the unified Drevi App
**Version 1.0 | July 2026 | Hand-off to Claude Code | Internal Document**

---

## 0. How to work through this document

You are evolving the **live** Drevi Wholesale Portal repo into the unified Drevi App. Real orders flow through this codebase daily. Work stage by stage, in order. Do not skip ahead, do not restructure beyond what a stage asks for, and never break an existing route, workflow, or the 10-minute sheet sync until the stage that explicitly retires it.

**Protocol:**

1. **Read first:** `CLAUDE.md` (golden rules, tokens, env), `README.md`, then the reference docs in `docs/` (§1.4). Re-read the relevant stage here before starting it.
2. **One stage = one PR** (large stages may split by their lettered sub-parts). Each stage ends with its **Done when** list passing and `npm run build:local` green.
3. **Parked dependencies:** items tagged `ANSH-##` need Ansh (credentials, sheet permissions, external accounts, sign-offs). When you hit one: **do not attempt it, do not mock around it in ways that would ship** — build everything up to the boundary, stub behind a clearly named env flag or disabled UI state, append the item to `docs/PARKED.md` (format in §14), and continue with the next buildable thing. Ansh clears the ledger when free.
4. **Decisions log:** proceed with the defaults in this guide without asking. If you must deviate, one line in `docs/DECISIONS.md` with the rationale.
5. **Migrations** continue the existing numbering (`0001`–`0014` after Stage 1) and stay idempotent like the rest.
6. **Strings:** every new user-facing label goes through `src/lib/strings.ts` (§6.2) — English now, Hindi later without a rewrite.
7. **Regression floor** after every stage: login (staff shortname + buyer), retail-check, exhibition billing finalise → PDF, catalog sync button, dashboard tiles, orders list. If any of these breaks, fix before proceeding.

---

## 1. Current state — the foundation (do not rediscover, this is accurate)

### 1.1 Stack & operations
Next.js 14 App Router · TypeScript · Tailwind (Royal Noir tokens) · Supabase (Postgres/Auth/RLS/Storage) · `googleapis` · `@react-pdf/renderer` · Interakt · Vercel Hobby · GitHub Actions (`sync-cron.yml` 10 min, `watchdog.yml` 10 min, `backup.yml` hourly). Sheet sync: Wholesale Master sheet → `wholesale_products` + admin-only `product_vendor_info`, Drive photos → public `product-photos` bucket, `locked_fields` protect manual edits, `sync_ignored_skus` protects renames. Atomic `next_order_number(prefix, day)` on `order_counters`. Idempotency via `client_ref`. Offline: localStorage autosave + IndexedDB queue. Invoice PDFs in private `order-pdfs`, sent via Interakt.

### 1.2 Routes today
- **Shop floor (staff+):** `/admin/retail-check`, `/admin/price-check`, `/admin/catalog`, `/admin/exhibition`, `/admin/in-store`
- **Back office (admin+):** `/admin/dashboard`, `/admin/orders`, `/admin/buyers`, `/admin/manage-catalog`, `/admin/audit`, `/admin/staff` (super-admin scope inside)
- **Buyer:** catalog, cart, `product/[sku]`, `order/[id]`, login, wholesale
- **API:** `api/cron/{sync-products,backup}`, `api/drive-photo`, orders, health
- **Roles:** `super_admin` (Ansh) · `admin` (Arushi, Rakesh) · `staff` (Jyoti, Grishma, Riddhi) · buyer. Middleware gates every route by role + status.

### 1.3 Shared machinery to reuse, never duplicate
`QrScanner` · `Lightbox`/`ZoomImage` · `useSort`/`SortTh` · `KeyboardInset` · `ProductCard`/`QuickView` · `OfflineSync` · `lib/{sync,sheets,drive,storage,order-pdf,order-finalize,offline,interakt,audit,stock,uuid,supabase/*}` · `scripts/{apply-migration,seed-auth,backup,probe-sheet}`. The four UX golden rules (scan on every search, zoom on every photo, sortable tables, keyboard-safe forms) apply to **every** screen this guide adds.

### 1.4 Reference docs (ANSH-02 places these before you start)
```
docs/specs/drevi-app-phase1-sku-vendors-spec-v1.md   ← Stage 1, execute as written
docs/design/drevi-app-prototype.html                 ← THE visual + interaction source of truth
docs/reference/sku-generator/{Code.gs,Index-v6.html} ← legacy tool (label math ported in Stage 1)
pipeline/                                            ← Python photo pipeline moved into this repo (Stage 4)
```
The prototype defines the shell, cockpit, scan sheet, Studio board, workbench, master editor and buyer storefront. Match it in structure, spacing, colour semantics and copy; it is a static mock — you supply real data, state and edge cases.

---

## 2. Target architecture (what all stages sum to)

One app, role-personalised. **Four spaces** — Sell (staff, phone), Stock (Arushi/Rakesh), Studio (Ansh/Grishma, desktop-leaning), Office (admins) — under a **Home cockpit** (cross-module "Needs you" inbox + today's money) and a **global scan** button whose action sheet exposes every module's action on a scanned SKU, role-gated. The **Studio** replaces the linear pipeline status with one **design record** and independent tracks (photos per-angle with engine choice; copy; per-portal publish gates) that converge on deliberate Push actions. **Supabase becomes source of truth** at Stage 8; the sheet becomes a read-only nightly mirror and the lock/ignore sync machinery is deleted. The **buyer app** stays a separate surface sharing the shell and tokens: storefront home, reorder rail, scan-to-reorder.

Navigation: **bottom tabs on mobile, left rail on desktop**, both rendered from one role-filtered config. English-only v1 through the strings layer.

---

## 3. Locked defaults (build to these; Ansh can revise later via DECISIONS)

| # | Decision | Locked default |
|---|---|---|
| D1 | Candidates per angle | **Keep every generated candidate.** Card shows the current one; "Previous attempts (n)" expands a history strip; approving any candidate makes it production and demotes the rest. |
| D2 | Auto-push on approve | **Never.** Approvals only change readiness. Push to a portal is always an explicit action. |
| D3 | Re-publish of a live design | Any change to a live design's approved set/copy ⇒ that portal's target flips to **`changes_pending`** with a visible **Re-push** action. No silent updates. |
| D4 | Engines v1 | `fashn` (try-on), `openai_bg` (background swap), `raw` (passthrough). `seedream` is a reserved enum value + disabled chip — no integration (ANSH-10). |
| D5 | Detail/macro angles | Never offered AI engines. `raw` only, "Approve as-is". Embroidery fidelity rule, enforced in UI and API. |
| D6 | Angle set | `front, back, side, closeup` (AI-eligible) + `detail_1, detail_2` (macro, raw-only). Extensible enum. |
| D7 | Pipeline state during transition | Python keeps working from the sheet until Stage 4 flips runner jobs to `--state supabase`; manual CLI default flips at Stage 8. Env `DREVI_STATE_BACKEND`. |
| D8 | Cost visibility | Any action that spends FASHN/OpenAI/Anthropic credits shows its estimate **before** firing (single and batch). Reuse the credit math from `pipeline/drevi_common.py`. |
| D9 | Copy model | `COPY_MODEL` env, default `claude-sonnet-4-6`; hero-tier designs use `claude-opus-4-8`. |
| D10 | Old URLs | Existing `/admin/*` paths keep working through Stage 2 via redirects; buyers' URLs never change. |

---

## 4. Stage plan

| Stage | Delivers | Migrations | Blocked by (parked) |
|---|---|---|---|
| 1 | SKU Generator + Vendors & Receipts (per Phase 1 spec) | 0013, 0014 | ANSH-01, 02, 03 |
| 2 | App shell, spaces nav, Home cockpit, global scan sheet | — | ANSH-09 (soft) |
| 3 | Studio data model + board (read + select) | 0015 | — |
| 4 | Job runner: GH Actions + Python integration, Drive backfill | 0016 | ANSH-04 |
| 5 | Workbench: per-angle review, engines, batch actions | — | ANSH-06 (openai_bg live) |
| 6 | Copy track (Claude vision) | — | ANSH-03 (key) |
| 7 | Publish gates: wholesale (7a), Shopify (7b) | 0017 | ANSH-05 (7b) |
| 8 | Master editor + cutover to Supabase SoT, sheet mirror | 0018, 0019 | ANSH-07 |
| 9 | Buyer storefront: home, reorder rail, scan-to-reorder, notify-me | 0020 | — |

Stages 5–7 can interleave at milestone level once 4 is done, but land PRs in numeric order.

---

## 5. Stage 1 — SKU Generator + Vendors & Receipts

Execute `docs/specs/drevi-app-phase1-sku-vendors-spec-v1.md` **as written**, milestones M1–M7. It is self-contained: migrations `0013` (`sku_registry` + `generate_sku` RPC) and `0014` (`vendors`, `goods_receipts`, `goods_receipt_lines`, `receipt-photos` bucket), the Google-Sheet interop (importer + mirror + `SKU_DUAL_MODE` floor), the generator UI, roll-label PDFs, and the receipts/vendors modules.

Routes land at `/admin/sku-generator`, `/admin/vendors`, `/admin/receipts` for now — Stage 2 re-homes them into Stock via the nav config, not by moving files.

**Parks:** ANSH-01 (service-account Editor on the registry sheet — mirror/floor code ships behind graceful failure until then), ANSH-02 (reference files), ANSH-03 (Vercel env vars). **Done when:** the Phase 1 spec's final acceptance checklist passes.

---

## 6. Stage 2 — App shell, spaces, cockpit, global scan

The IA change. Nothing here adds business capability; it reorganises what exists and adds the two cross-cutting surfaces (cockpit, scan sheet). Match `docs/design/drevi-app-prototype.html` closely.

### 6.1 Navigation config — `src/lib/nav.ts`
One typed config drives both nav renderings:

```ts
type Space = { key:'home'|'sell'|'stock'|'studio'|'office'; label:StringKey; icon:string;
               roles:Role[]; items:{ label:StringKey; href:string; roles?:Role[] }[] };
```
- **Sell** → retail-check, price-check, catalog, exhibition, in-store (staff+)
- **Stock** → sku-generator, receipts, vendors, reorder (reorder = the dashboard's Reorder view given its own route `/admin/reorder`, admin+; sku-generator staff+)
- **Studio** → board, (workbench/master are drill-ins, not nav items) (admin+; Grishma is staff — add per-item `roles` override granting her Studio: parked as **ANSH-09**, ship with admin+ until Ansh confirms role mapping)
- **Office** → dashboard, orders, buyers, audit, staff (admin+; staff mgmt super-admin)
- **Home** → everyone (staff-side).

### 6.2 Strings layer — `src/lib/strings.ts`
`const STRINGS = { en: { 'nav.sell':'Sell', … } }` + `t(key)` helper. New screens use it exclusively; migrating legacy screens' copy is **not** in scope (touch labels only where you already touch the file).

### 6.3 AppShell — `src/components/shell/AppShell.tsx`
- Mobile (<768px): brand bar + scrollable body + **bottom tab bar** — Home, then the user's spaces in order, centre **gold scan FAB** always. Max 4 tabs + scan; if a role has more spaces than slots (only super_admin), overflow into Home tiles exactly as the prototype does (Studio/Office reachable from Home).
- Desktop: **left rail** — brand, space headers with expanded item lists, scan as a rail button; content area unconstrained.
- Sub-screens keep their parent space lit (parent map like the prototype's).
- Wrap **staff/admin routes only**. Buyer layout untouched until Stage 9.
- `/admin` and `/` (staff) land on **Home**; D10: legacy deep links keep resolving (nav points at existing paths — no file moves, so only new routes need `redirects()` entries if any rename happens; prefer zero renames this stage).

### 6.4 Home cockpit — route `/admin/home`
Per prototype: greeting + role, sync stamp; **Today metrics** (reuse dashboard queries: sales, orders·pcs, advance in, balance due, IST ranges); **Needs you** inbox; **Quick actions** (Scan primary; New bill, New SKU, Log receipt, Price check — role-filtered); **Spaces** tiles.

`GET /api/home/attention` → ordered items `{key,title,sub,count,severity,href}` computed by **cost of inaction**: (1) money-blocking — orders in `submitted` with uncollected balance (sum shown); (2) buyers `pending`; (3) designs needing photos / needing review (from Stage 3 states; return 0-count gracefully before Stage 3 ships); (4) failed pipeline jobs (Stage 4+); (5) reorder sold-out best-sellers (existing reorder query). Every item deep-links with the target filter pre-applied. Each count must be one indexed query; add indexes if any plan scans. **Empty state:** "All clear — N orders billed today." with the day's count.

### 6.5 Global scan sheet — `src/components/shell/ScanSheet.tsx`
FAB → existing `QrScanner` → `GET /api/scan/resolve?sku=` →
```ts
{ sku, known:boolean, title?, thumb?, retail_price_set?, design_id?, actions:Action[] }
```
Actions assembled **server-side, role-gated**: Check retail price → `/admin/retail-check?sku=`; Add to current bill (only if a wizard draft exists in this session — the sheet deep-links `/admin/exhibition?add=` or `/in-store?add=`, and the wizard consumes `?add=` by appending a line); Log into a receipt → `/admin/receipts/new?sku=`; Open in studio → workbench (Stage 3+); Edit product master → manage-catalog modal deep-link `?sku=` (Stage 8 re-homes); Add to print sheet (writes the Stage 1 localStorage tray, toast). **Unknown SKU:** show "Not in the system" + role-gated "Create SKU" → `/admin/sku-generator?variant=` prefill. Wire the existing per-page scan buttons to keep their current focused behaviour — the FAB is additive.

**Done when:** every legacy route renders inside the shell with correct tab/rail highlighting; cockpit numbers reconcile with the dashboard for the same range; every inbox row lands filtered; scan FAB works from all staff screens incl. mid-billing (`?add=` appends); a `staff`-role login sees only Home+Sell (+scan), no Studio/Office anywhere; regression floor passes.

---

## 7. Stage 3 — Studio data model + board

### 7.1 Migration `0015_studio.sql`
```sql
create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  base_sku text not null, color text not null,          -- group key
  title text, category text, sub_category text,
  tier text not null default 'standard' check (tier in ('standard','hero')),
  fabric text, handwork text, origin text,              -- spec mirror (sheet-owned until Stage 8)
  specs_verified boolean not null default false,        -- Rakesh confirmation flag
  drive_input_id text, drive_processed_id text, drive_tryon_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (base_sku, color)
);
create table if not exists design_angles (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references designs(id) on delete cascade,
  angle text not null check (angle in ('front','back','side','closeup','detail_1','detail_2')),
  source_ref text,                                       -- drive file id of mannequin/macro source
  prompt text default '', prompt_edited_by_human boolean not null default false,
  engine text not null default 'fashn' check (engine in ('fashn','openai_bg','raw','seedream')),
  approved_candidate_id uuid,                            -- FK added after image_candidates
  updated_at timestamptz default now(),
  unique (design_id, angle)
);
create table if not exists image_candidates (
  id uuid primary key default gen_random_uuid(),
  angle_id uuid not null references design_angles(id) on delete cascade,
  engine text not null, params jsonb default '{}'::jsonb,
  file_ref text not null,                                -- drive id or storage path
  status text not null default 'generated' check (status in ('generated','approved','rejected')),
  cost_credits numeric default 0, job_id uuid, created_by text, created_at timestamptz default now()
);
alter table design_angles add constraint da_approved_fk
  foreign key (approved_candidate_id) references image_candidates(id) deferrable;
create table if not exists design_copy (
  design_id uuid primary key references designs(id) on delete cascade,
  title text, description text, tags jsonb default '[]'::jsonb,
  status text not null default 'none' check (status in ('none','draft','approved')),
  model text, generated_at timestamptz, edited_by text, approved_by text, approved_at timestamptz
);
create table if not exists publish_targets (
  design_id uuid not null references designs(id) on delete cascade,
  portal text not null check (portal in ('wholesale','shopify')),
  enabled boolean not null default true,
  state text not null default 'not_ready' check (state in
    ('not_ready','ready','pushing','live','changes_pending','error')),
  last_pushed_at timestamptz, remote_id text, error text,
  primary key (design_id, portal)
);
```
Indexes: `designs(base_sku)`, `image_candidates(angle_id, created_at desc)`, `publish_targets(state)`. RLS: deny anon/buyer; detail-angle rows reject non-`raw` engines via check-in-API (D5).

### 7.2 Derived state — `src/lib/studio/state.ts` (one implementation, used by board, chips, cockpit)
Inputs: specs_verified, per-angle approvals, copy.status, publish_targets. Outputs the badge (`Awaiting specs → Needs photos → In review → Needs copy → Ready · <portal> → Live · <portals> → Changes pending`) and per-portal **gate**: wholesale = ≥1 approved image AND wholesale price set (from `wholesale_products`); shopify = front+back approved AND copy approved AND tier set. Gates are pure functions with unit tests — Stage 7 pushes call the same functions.

### 7.3 Ingest
Extend the existing sheet sync: for every synced row, parse `DD-CAT-SUB-###-SIZE-COLOR`, upsert the `(base,color)` design (title/category/spec mirror fields; never downgrade `specs_verified`), and ensure the 6 `design_angles` rows exist. Idempotent, additive — sync behaviour for products is untouched.

### 7.4 Board — `/admin/studio` (+ desktop table variant)
Per prototype: derived-state filter chips with live counts (each chip = one query over 7.2 states), rows with thumb (approved front → source front → placeholder, via drive-photo proxy), SKU, badge, dot-strip (`✓ specs · ◑ 2/4 · ○ copy · ▪WS ▫SH`), checkbox multiselect → **batch bar** listing only actions valid for the whole selection. This stage the batch actions render with counts/cost estimates but the spend/push ones are disabled with "runner arrives next" tooltips; **Set tier** and **Toggle portal enabled** work now. Desktop: full sortable table per golden rule 3. Row tap → workbench shell (Stage 5 fills it; ship a skeleton with real header + states now).

**Done when:** post-sync board shows every catalog design truthfully at `Awaiting specs`/`Needs photos`; chips' counts sum correctly; multiselect + the two live batch actions work and audit-log; cockpit's studio rows now read real counts.

---

## 8. Stage 4 — Job runner (GH Actions + Python)

### 8.1 Migration `0016_pipeline_jobs.sql`
```sql
create table if not exists pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('preprocess','vision','tryon','openai_bg','scan_drive','copy')),
  design_id uuid references designs(id), angle_id uuid references design_angles(id),
  params jsonb default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','claimed','running','done','error','cancelled')),
  progress int not null default 0, log text default '', cost_credits numeric default 0,
  requested_by text, runner_id text,
  created_at timestamptz default now(), started_at timestamptz, finished_at timestamptz
);
create index if not exists pj_status_idx on pipeline_jobs(status, created_at);
```
Enable Supabase **Realtime** on this table.

### 8.2 Pipeline moves into the repo (`pipeline/`) — ANSH-02 copies it in
Refactor **around** the stage scripts, not through them:
- `pipeline/runner.py` — `--job <id>`: claim (queued→claimed→running, set runner_id), execute by `type`, stream `JobReporter` updates, finish `done|error`.
- `drevi_common.py` gains `JobReporter` (Supabase REST: status/progress/appended log/cost) and a **state backend switch** (D7): `--state sheet|supabase`. Runner always passes `supabase` — reads/writes photo-state, prompts, candidate registration against Stage 3 tables; manual CLI defaults to `sheet` until Stage 8. Candidate outputs upload to the existing Drive folders (unchanged) and register `image_candidates` rows with `file_ref`.
- New `pipeline/04_openai_bg.py`: background swap on the source (garment pixels untouched) via `OPENAI_API_KEY` — behind flag until ANSH-06.
- `type='scan_drive'`: walk INPUT/PROCESSED/TRYON for a design (or `--all` backfill), fill `source_ref`s and historic candidates so the board becomes fully truthful about pre-app work.
- Respect `prompt_edited_by_human` — never regenerate over it without `params.force`.

### 8.3 Dispatch & workflow
- `.github/workflows/pipeline-runner.yml`: `workflow_dispatch` inputs `{job_id}`; checkout, Python 3.11 + cached pip, `python -m pipeline.runner --job $JOB_ID --state supabase`; `concurrency: group: design-${design_id}`; 30-min timeout; repo secrets per §15 (**ANSH-04**).
- `POST /api/pipeline/jobs` (admin+): validate (D5: reject AI engines on detail angles), insert row, fire the GH dispatch (`GITHUB_PAT` scoped to Actions, **ANSH-04**), return job. `POST /api/pipeline/jobs/:id/cancel` (only `queued`).
- UI: job chips/toasts subscribe via Realtime — queued → running n% → done/error with log expand; "~15–40 s to start" copy on queued (GH cold start). Cockpit inbox item (4) now live on `status='error'`.
- Batch bar's spend actions go live: expand selection → per-angle jobs, one confirm listing job count + credit estimate (D8).

**Done when:** dispatching FASHN on one design runs end-to-end on Actions with live progress in the workbench skeleton and a registered candidate; `scan_drive --all` backfills the July catalog; a failed job surfaces in cockpit; killing a run mid-way leaves a resumable `error` row, never a stuck `running` (runner traps + finalises).


---

## 9. Stage 5 — Workbench

Route `/admin/studio/[designId]` replacing the Stage 3 skeleton. Match the prototype card-for-card.

- **Header:** SKU · color mono title, name sub, derived badge; master shortcut icon (opens Manage Catalog modal for now; Stage 8 re-homes).
- **Destination strip:** per-portal chip with gate result from `studio/state.ts` — `ready` / `n blocker(s)` (tap lists the exact unmet rules) / `live` / `changes_pending`.
- **Angle cards** (front, back, side, closeup): source vs current-candidate pair (both zoomable — golden rule 2); status badge (`Needs source` / `Queued` / `Running n%` / `Needs review` / `Approved` / `Failed`); engine chips per D4 (`seedream` disabled with "coming later"); prompt box (collapsed; edit sets `prompt_edited_by_human`; hidden for `raw`); actions **Approve · Reject · Regen** (Regen shows the credit cost inline, D8, and dispatches a Stage 4 job); D1 history: "Previous attempts (n)" strip, any historic candidate can be approved.
- **Approve** sets `approved_candidate_id` + candidate `approved` (demote previous per D1); if the design is `live` anywhere, flip that portal to `changes_pending` (D3). **Reject** marks the candidate `rejected`, slot returns to review with prompt open.
- **Detail cards** (detail_1/2): no engine chips, fidelity note, **Approve as-is** (registers/approves a `raw` candidate over the macro source). API enforces D5.
- **Copy panel:** Stage 6 fills; render status-aware placeholder now.
- **Push buttons:** wired to Stage 7; until then render gate-truthful but disabled ("publishing arrives in Stage 7").
- Board batch actions all live now: Run FASHN (pending AI angles), Approve all (only candidates in `generated`… batch-approve requires per-item confirm list — show the n thumbnails in the confirm sheet), Generate copy (Stage 6), Set tier, Push wholesale (Stage 7).

**Done when:** a design can go source → generate → review → approve on every angle from the phone; engine switching + regen respects human-edited prompts; every approval on a live design produces `changes_pending`; detail angles cannot be sent to any AI engine via UI **or** API; all images zoom; audit entries on approve/reject.

---

## 10. Stage 6 — Copy track (Claude vision)

- `POST /api/studio/copy/generate` (admin+; also job `type='copy'` for batch): inputs = approved images (fallback: sources) + `designs` spec fields + tier. **STRICT_SPEC_MODE:** if `specs_verified=false`, refuse with "Awaiting Rakesh's specs" (batch skips + reports, matching the existing pipeline principle).
- Prompting: server-side Anthropic call (`ANTHROPIC_API_KEY`, model per D9), template from `docs/reference/copy-template.md` (ANSH-02 drops the existing Drevi copy template in; until present, a minimal built-in: title ≤ 60 chars, 2–3 sentence description in brand voice — no exclamation marks, sentences end with periods — plus `tags{occasion,fabric,silhouette,color}`). Structured-JSON response, validated.
- Panel per prototype: draft text, tag chips, **Approve copy · Edit (inline, saves as edited draft) · Regen** (cost shown, D8). Approving sets `status='approved'` + approver; editing after approval reverts to `draft` and triggers D3 `changes_pending` where live.
- Cockpit/board "Needs copy" now real.

**Done when:** single + batch generation works with STRICT_SPEC_MODE skips reported; edit→approve flow round-trips; an unverified-spec design cannot receive generated copy through any path.

---

## 11. Stage 7 — Publish gates

### 11.1 Migration `0017_publishing.sql`
`create table if not exists product_images (sku_base text, color text, angle text, storage_path text, source_candidate_id uuid, published_at timestamptz, primary key (sku_base,color,angle));` + public **`product-images`** bucket (mirrors how `product-photos` was provisioned).

### 11.2 Stage 7a — Wholesale (internal, no external deps)
- `POST /api/studio/publish/wholesale` (single + batch): run the wholesale gate (7.2) — hard fail with reasons if unmet; copy each approved candidate's file from Drive into `product-images` (s1200 web + s800 thumb, reuse `lib/drive` + `lib/storage`); upsert `product_images`; set `wholesale_products` image refs for all size variants of the group to the new set, description from approved copy when present; flip target `live` (+`last_pushed_at`); audit.
- Buyer-facing product/card components read `product_images` first, legacy `product-photos` fallback — zero regression for unpublished designs.
- `changes_pending` → **Re-push** runs the same routine idempotently.
- "Push wholesale · raw ok" is just the loose gate doing its job — no special path.

### 11.3 Stage 7b — Shopify (**ANSH-05**: app Client ID/Secret + shop domain)
- `lib/shopify.ts`: Client-Credentials token flow (`POST /admin/oauth/access_token`, cache ~23 h — static `shpat_` tokens are deprecated; never store long-lived tokens).
- Push: gate check → if no `remote_id`, `productCreate` (**DRAFT** status, title/description/tags from approved copy, variants from `sku_registry` sizes for the group, prices from master) → `productCreateMedia` with the approved set → save `remote_id`, target `live`. Re-push: update copy/media (replace media set), clear `changes_pending`. Errors land in `target.error` + cockpit.
- Until ANSH-05 clears: full implementation behind `SHOPIFY_ENABLED=false`; buttons render "Connect Shopify — parked (ANSH-05)".
- Going live from DRAFT stays a human act inside Shopify admin — deliberate scope line, note it in the UI copy.

**Done when:** 7a — a raw-only design publishes to wholesale and renders for a buyer; approving a better photo yields `changes_pending`, Re-push updates it. 7b (post-unpark) — a gated design creates a draft Shopify product with media; re-push updates it; gate blocks copy-less pushes.


---

## 12. Stage 8 — Master editor + cutover to Supabase source of truth

The highest-risk stage: it changes the data contract under a live portal. Sub-parts land as separate PRs; **12.4 requires ANSH-07 sign-off before merging.**

### 12.1 Master editor
Evolve **Manage Catalog into the Product Master editor** (one editor, not two): re-home at `/admin/studio/master/[designId]` + keep `/admin/manage-catalog` redirecting. Per prototype sections — Specs (fabric/handwork/origin + `specs_verified` toggle labelled "Confirmed by Rakesh"), Pricing (last cost readonly from receipts/vendor info, **auto-MRP** = cost × tier multiplier rounded to nearest ₹99 with an **override** field; Final MRP/Wholesale), Publish toggles (writes `publish_targets.enabled`), plus the existing photo/visibility/rename tools. Group-level fields edit once per design; size-level (stock) per variant. Every save audit-logged.

### 12.2 Migration `0018_master_ownership.sql`
Pricing columns on `designs` (`auto_mrp numeric, mrp_override numeric, markup_multiplier numeric`), `products_master_view` joining designs + variants for anything still reading sheet-shaped data, and backfill from current synced values.

### 12.3 Sheet mirror (comfort + backup)
`.github/workflows/master-mirror.yml` (nightly) → `/api/cron/export-master`: Supabase → a **new tab** `App Mirror` on the Wholesale Master sheet, one-way, full snapshot, "MIRROR — edits here do nothing" banner row. Ships **before** cutover so the team sees it working.

### 12.4 Cutover (gated by **ANSH-07**)
1. **Parallel week:** sync keeps running; `/api/dev/master-diff` reports sheet-vs-Supabase divergence daily into `docs/CUTOVER-LOG.md`. Team edits move to the app (bilingual SOP for Arushi/Rakesh is Ansh's side).
2. Flip: sync-cron's product step → **no-op behind `SHEET_SYNC_ENABLED=false`** (keep photo-fetch retries until Studio covers all legacy photos); editor becomes the only writer.
3. `0019_cleanup.sql`: drop `locked_fields` usage, `sync_ignored_skus`, lock UI, sheet-floor SKU dual mode (`SKU_DUAL_MODE=false` — pairs with ANSH-08 retiring the Apps Script).
4. Python CLI default state → `supabase` (D7 completes). `pipeline` docs updated.
5. **Rollback:** re-enable `SHEET_SYNC_ENABLED`, re-apply locks from the audit trail (write the restore script *before* flipping).

**Done when:** a price edited in the editor reaches retail-check, wholesale, and label print-data with the sheet untouched; mirror tab refreshes nightly; diff report clean for 5 consecutive days pre-flip; post-flip regression floor + Stage 1 label pricing all pass.

---

## 13. Stage 9 — Buyer storefront

Per the prototype's buyer app; buyer URLs unchanged (D10), new home replaces the current catalog-as-landing.

- **Home:** status strip (latest active order → order page; back-in-stock strip when `notify_me` hits exist); **Reorder your usuals** — top designs from this buyer's order history (real-pieces aware), current stock state + list price + MOQ, one-tap add; **New this week** (first published ≤7 days); category chips. List wholesale prices only — no personalised discounts anywhere (pricing firewall; "Final pricing is confirmed by Drevi on your order." stays on cart).
- **Scan-to-reorder:** buyer-mode FAB + `/api/scan/resolve` returns only View product / Add to cart; unknown or hidden SKUs → "Not available on the wholesale portal." Nothing operational leaks.
- **Notify me:** migration `0020_notify_me.sql` (`buyer_id, sku_base, color, created_at, fulfilled_at`); button on sold-out cards; on stock>0 (editor/receipt-applied), surface in the buyer's strip + admin sees a "notify requests" count on the design. Automated WhatsApp nudge = **parked follow-up**, not this stage.
- Product page: gallery = published `product_images` set (raw or edited — whatever wholesale gate shipped), thumbnails, stock state, MOQ stepper.

**Done when:** a buyer with history sees their usuals ranked correctly; scanning a tag in their own shop lands on the product with add-to-cart; notify-me round-trips to the strip when stock returns; no buyer response ever contains cost, vendor, or staff-only fields (assert in tests).

---

## 14. Parked ledger — Ansh's side (`docs/PARKED.md`)

Maintain this file; append when blocked, check off when cleared. Seed it with:

| ID | What Ansh does | Unblocks |
|---|---|---|
| ANSH-01 | Grant service account **Editor** on the SKU Registry sheet | Stage 1 mirror + dual-mode floor |
| ANSH-02 | Drop reference files + copy `pipeline/` into the repo (docs/specs, docs/design, docs/reference, pipeline/) | Stages 1, 4, 6 |
| ANSH-03 | Vercel + `.env.local` vars per §15 (incl. `ANTHROPIC_API_KEY`) | Each stage's new vars |
| ANSH-04 | GitHub: repo secrets for the runner + a PAT scoped to Actions dispatch | Stage 4 |
| ANSH-05 | Shopify custom app **Client ID/Secret** + shop domain | Stage 7b |
| ANSH-06 | `OPENAI_API_KEY` (background engine) | Stage 5 `openai_bg` live |
| ANSH-07 | Review cutover diff log; give the go/no-go | Stage 12.4 |
| ANSH-08 | Repoint legacy Apps Script `doGet` to the portal; set `SKU_DUAL_MODE=false` | Post-Stage-1 adoption |
| ANSH-09 | Confirm role→space grants (Grishma: Studio? Rakesh: Stock scope) in `nav.ts` | Stage 2 personalisation final |
| ANSH-10 | Seedream evaluation | Someday — enum reserved |

`PARKED.md` row format: `- [ ] ANSH-## · <stage/feature stubbed> · <exact flag or file waiting> · <what to hand back>`.

---

## 15. Environment & secrets by stage (register in `src/lib/env.ts` + `CLAUDE.md`)

| Stage | Vercel env | GitHub secrets |
|---|---|---|
| 1 | `SKU_REGISTRY_SHEET_ID`, `SKU_REGISTRY_TAB`, `SKU_DUAL_MODE` | — |
| 4 | `GITHUB_PAT`, `GITHUB_RUNNER_REPO` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `FASHN_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| 5 | `OPENAI_BG_ENABLED` | — |
| 6 | `ANTHROPIC_API_KEY`, `COPY_MODEL` | — |
| 7b | `SHOPIFY_ENABLED`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | — |
| 8 | `SHEET_SYNC_ENABLED` | — |

Existing vars (Supabase, Google SA, `CRON_SECRET`, Interakt) carry through unchanged.

---

## 16. Global acceptance (run after Stage 9, and the regression floor after every stage)

1. **The thread test:** goods arrive → receipt logged (scan-in) → new SKU minted → label printed → design appears on the board `Awaiting specs` → specs verified in the master editor → sources backfilled → FASHN on front/back, raw details approved → copy generated + approved → Push wholesale (buyer sees it) → Push Shopify draft → a photo re-approved → `changes_pending` → Re-push. One garment, every module, no re-keying.
2. **Scan universality:** the same tag scanned from Home, mid-bill, in Receipts, in Studio, and as a buyer produces the correct role-gated sheet each time.
3. **Security invariants:** buyer responses never contain cost/vendor/staff fields; staff never see raw cost outside coded labels; detail angles reject AI engines at the API; no spend without a shown estimate.
4. **Ops invariants:** backups/watchdog untouched; every migration re-runs clean; `PARKED.md` and `DECISIONS.md` reflect reality.
5. **Prototype fidelity:** side-by-side each built screen against `drevi-app-prototype.html` — structure, states, and copy match or a DECISIONS line says why.
