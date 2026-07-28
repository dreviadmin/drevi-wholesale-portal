# Parked ledger — items waiting on Ansh (build guide §14)

Format: `- [ ] ANSH-## · <stage/feature stubbed> · <exact flag or file waiting> · <what to hand back>`

- [x] ANSH-01 · Stage 1 registry mirror + dual-mode floor · registry sheet Editor grant · CLEARED 25 Jul 2026 (361-row history imported, mirror verified)
- [ ] ANSH-02 · Stage 4/6 references (partially cleared) · `docs/design/drevi-app-prototype.html` DELIVERED 25 Jul (Stage 2 fidelity pass done same day); still waiting: `docs/reference/sku-generator/{Code.gs,Index-v6.html}`, `docs/reference/copy-template.md`, `pipeline/` copy into repo · Pipeline lives at `~/Documents/drevi/pipeline` (creds in its `.env`) — will be copied into the repo at Stage 4.
- [ ] ANSH-03 · per-stage env vars on the PROD Vercel project (dev project is self-managed) · §15 table (incl. `ANTHROPIC_API_KEY`) · needed only at production cutover — all stages ship to the DEV project first per Ansh's 25 Jul directive.
- [ ] ANSH-04 · Stage 4 job runner · GitHub repo secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `FASHN_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) + a PAT scoped to Actions dispatch (`GITHUB_PAT`) · hand back: secret names confirmed set.
- [ ] ANSH-05 · Stage 7b Shopify push · `SHOPIFY_ENABLED` + custom app Client ID/Secret + shop domain · until then buttons render "Connect Shopify — parked (ANSH-05)".
- [ ] ANSH-06 · Stage 5 `openai_bg` engine live · `OPENAI_API_KEY` / `OPENAI_BG_ENABLED` · engine chip ships disabled.
- [ ] ANSH-07 · Stage 8 cutover go/no-go · review `docs/CUTOVER-LOG.md` (needs 5 clean days; team edits must move to the master editor first) · verbal sign-off, then: SHEET_SYNC_ENABLED=false + cleanup migration + pipeline CLI default → supabase.
- [ ] ANSH-08 · post-Stage-1 adoption · repoint legacy Apps Script `doGet` to the portal; set `SKU_DUAL_MODE=false` · confirmation the old tool is retired.
- [ ] ANSH-09 · Stage 2 role→space grants · per-item `roles` overrides in `src/lib/nav.ts` (Grishma → Studio? Rakesh Stock scope?) · shipped with admin+ defaults until confirmed.
- [ ] ANSH-10 · Seedream evaluation · `seedream` stays a reserved enum + disabled chip · someday.
- [ ] ANSH-18 · Shopify inventory sync · direction, cadence, conflict rule · until then Supabase reads HIGH for anything sold via Shopify POS — correct with a stock take (§10.4).
- [ ] ANSH-19 · Per-design Drive folders · consolidate each SKU's photos, clear `docs/DRIVE-FOLDER-AUDIT.md`, then supply `DRIVE_DESIGN_FOLDER_ID` · unblocks every image-upload path (§4.1). Until set: uploads disabled with an inline message, everything else works.
- [ ] ANSH-20 · Device/floor scope (Addendum 2B) not built in this repo · no `devices` table, no PIN unlock · delivery intake, specs view and stock take ship with admin role gating; wiring to floor scope is a nav/middleware change if 2B lands later.
