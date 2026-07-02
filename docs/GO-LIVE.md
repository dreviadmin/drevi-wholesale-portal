# Drevi Wholesale Portal — Stack Explainer & Go-Live Guide

Target setup (decided 2 Jul 2026): **Vercel Hobby + Supabase Free — ₹0/month**.

Supabase Free's two weaknesses are neutralised by the deployment itself:
auto-pause never triggers because the 10-minute sync keeps the project active
around the clock, and a daily GitHub Actions job pulls a full-database export
off Supabase (90-day retention). **Upgrade to Supabase Pro (~₹2,200/mo) later
only if** you want point-in-time recovery / managed backups, approach the free
limits (500 MB database / 1 GB storage — years away; images live on Shopify's
CDN), or want an SLA once serious revenue flows through the portal.

---

## 1. The stack — who does what

```
                     ┌─────────────────────────────────────────────┐
   Rakesh fills      │  GOOGLE SHEET (Product Master)              │  garment truth:
   wholesale columns │  price, visibility, stock, restockability   │  edited by humans
                     └───────────────┬─────────────────────────────┘
                                     │  read every 10 min (service account)
                                     ▼
┌──────────────┐  images only  ┌─────────────────────────────────────┐
│   SHOPIFY    │──────────────►│  SYNC (api/cron/sync-products)      │
│ (drevi-      │  OAuth CCG    │  runs on Vercel, writes to Supabase │
│  fashion)    │               └───────────────┬─────────────────────┘
└──────────────┘                               ▼
                     ┌─────────────────────────────────────────────┐
                     │  SUPABASE (managed Postgres)                │
                     │  • tables: wholesale_products, buyers,      │
                     │    orders, carts, staff_users,              │
                     │    exhibition_sessions, auth_audit_log,     │
                     │    shopify_tokens                           │
                     │  • Auth: email/password logins              │
                     │  • Storage: order-pdfs, buyer-cards         │
                     │  • RLS: row-level security = the real gate  │
                     └───────────────┬─────────────────────────────┘
                                     │
                     ┌───────────────▼─────────────────────────────┐
                     │  NEXT.JS APP on VERCEL                      │
                     │  buyer catalog/cart · admin · exhibition ·  │
                     │  invoice PDFs · QR scanner · PWA offline    │
                     └───────────────┬─────────────────────────────┘
                                     │  (once API key added)
                                     ▼
                     ┌─────────────────────────────────────────────┐
                     │  INTERAKT — WhatsApp/email sends            │
                     └─────────────────────────────────────────────┘
```

| Piece | Role | You pay |
|---|---|---|
| **Next.js app** (this repo) | Every screen and every server action — buyer catalog/cart/orders, admin (buyers, orders, staff, audit), exhibition/in-store billing, PDF generation, QR scanning, offline queue | — |
| **Vercel** | Builds + hosts the app; every page/action runs as a serverless function; HTTPS + domain | Hobby ₹0 |
| **Supabase** | The database (PostgreSQL — fully ACID), login system (Auth), file storage (PDFs, visiting cards), and row-level security | Free ₹0 (Pro ~₹2,200/mo later if needed) |
| **Google Sheet** | Where garments actually live (the Product Master the AI pipeline also uses). The portal never writes to it | ₹0 |
| **Shopify** | Product **images only**, fetched during sync via the Client Credentials Grant app | existing plan |
| **Interakt** | WhatsApp + email templates (order confirmations, alerts to Rakesh) | existing plan |
| **GitHub** | Code home; Vercel deploys from it; free Actions cron triggers the 10-min sync (Hobby crons are daily-only) | ₹0 |

**Languages:** TypeScript/React (`.ts`/`.tsx`) for the entire app · SQL for the schema (`supabase/migrations/`) · plain Node scripts (`.mjs`) for ops · one bash script (`portal.sh`).

---

## 2. Where the code lies — important files

```
wholesale-portal/
├── src/app/                     ← every URL = a folder here
│   ├── login/ · forgot-password/ · wholesale/   public pages
│   ├── catalog/ · product/[sku]/ · cart/ · order/[id]/ · account/orders/   buyer
│   ├── admin/
│   │   ├── buyers/ (+ [id], new)   buyer management + credentials
│   │   ├── orders/ (+ [id])        confirm / send invoice / share
│   │   ├── exhibition/ (+ [id])    E1–E6 wizard (exhibition & in-store billing)
│   │   ├── staff/                  role management
│   │   └── audit/                  credential/login log
│   └── api/
│       ├── cron/sync-products/     THE sync (bearer CRON_SECRET)
│       ├── orders/[id]/pdf/        on-demand invoice PDF
│       └── dev/*                   dev-only helpers (disabled in production)
├── src/lib/                     ← the brains
│   ├── sync.ts                  Sheet→DB sync rules (STRICT_FILTER flag lives here)
│   ├── sheets.ts                Google Sheet reader (2-row header logic)
│   ├── shopify-auth.ts          Shopify token + image fetching
│   ├── stock.ts                 the four-state stock model
│   ├── variants.ts              base-SKU grouping (size/color chips)
│   ├── cart.ts                  buyer cart rules (MOQ, caps, special requests)
│   ├── order-pdf.tsx            the invoice/order-request PDF
│   ├── crypto.ts                AES-256-GCM for buyer passwords
│   ├── interakt.ts              WhatsApp/email templates
│   ├── offline.ts               IndexedDB queue for exhibitions
│   └── supabase/                DB clients (browser / server / admin)
├── src/components/              StockPill, ProductCard, QrScanner, …
├── src/middleware.ts            auth gate on every request
├── supabase/migrations/         0001–0006 = the entire schema (idempotent)
├── scripts/                     apply-migration, seed-auth, backup, portal.sh
├── .github/workflows/sync-cron.yml   10-min sync trigger (GitHub Actions)
├── vercel.json                  daily backstop cron
└── .env.local                   ALL secrets (never committed)
```

---

## 3. Connection details (environment variables)

Everything the app connects to is configured by env vars — locally in `.env.local`,
in production via **Vercel → Project → Settings → Environment Variables**.

| Variable | Connects to | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase, as a logged-in user | safe in the browser; RLS restricts rows |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase, as root | server-only — bypasses RLS |
| `PORTAL_PASSWORD_MASTER_KEY` | — | AES key for buyer-password reveal; **back it up in a password manager** |
| `CRON_SECRET` | — | bearer token the sync endpoint demands |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Sheet | locally a file path; **on Vercel paste the JSON content itself** (the code accepts either) |
| `GOOGLE_SHEET_ID` | Google Sheet | the Product Master |
| `SHOPIFY_STORE_DOMAIN` | Shopify | `drevi-fashion.myshopify.com` (with hyphen!) |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Shopify | Dev-Dashboard app, Client Credentials Grant |
| `INTERAKT_API_KEY` | Interakt | optional until templates approved; sends no-op without it |
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_URL` | Supabase management | ops-only (migrations); **not** needed on Vercel |

---

## 4. How a garment reaches the portal

1. The AI pipeline photographs the garment and creates the Shopify product; the
   **Product Master Sheet** row gets `Shopify Product ID` / URLs.
2. **Rakesh fills the wholesale columns** in the sheet: `Final Wholesale` (price),
   `Wholesale Visible` (Y), `Min Order Qty - Wholesale`, `Restockable` (Y/N),
   `Restock Days` (if Y), and the product gets its `Shopify Live URL` when published.
3. The **sync** (every 10 min) reads the sheet, keeps qualifying rows, copies them
   into Supabase `wholesale_products`, and pulls image URLs from Shopify
   (cached 7 days). Rows that stop qualifying are hidden, never deleted.
4. The catalog reads only from Supabase — fast, and never hits the sheet per visit.

> ⚠️ `src/lib/sync.ts` currently runs `STRICT_FILTER = false` (blank
> `Wholesale Visible` counts as visible; draft product URLs accepted) because the
> sheet's wholesale columns aren't filled yet. **Before real buyers arrive:** fill
> the columns, publish the products, then flip `STRICT_FILTER = true`.
> Until `Restockable` is populated, everything shows the "Limited Edition" pill.

Stock states: qty>0+restockable → In Stock · qty>0+not → Limited (capped) ·
qty 0+restockable → Made to Order (Nd) · qty 0+not → Sold Out.

---

## 5. Go-live, step by step

### A · Accounts (~20 min)
1. **Supabase stays Free** — no billing action. The 10-min sync (step 7) keeps
   the project awake; the daily backup workflow (step 7) is the safety net.
2. **GitHub**: create a **private** repo (e.g. `dreviadmin/drevi-wholesale-portal`), then
   ```bash
   cd ~/Documents/drevi/wholesale-portal
   git remote add origin git@github.com:dreviadmin/drevi-wholesale-portal.git
   git push -u origin main
   ```
3. **Vercel**: sign up (Hobby) with that GitHub account.

### B · Deploy (~30 min)
4. Vercel → **Add New Project** → import the repo. Framework auto-detects Next.js.
5. Before the first deploy, add **all env vars from §3** (Production scope).
   For `GOOGLE_SERVICE_ACCOUNT_JSON`, open the local `drevi-pipeline-sa.json`
   and paste its entire content as the value.
6. Deploy → smoke-test the `*.vercel.app` URL (login, catalog).
7. **Sync + backup cadence**: in the GitHub repo → Settings → Secrets → Actions,
   add `PORTAL_URL` (your prod URL) and `CRON_SECRET` (same as Vercel). The two
   included workflows then run automatically: `sync-cron.yml` syncs products
   every 10 min (also keeps Supabase Free from ever pausing) and `backup.yml`
   stores a full-database export daily as a GitHub artifact (90-day retention).
   `vercel.json` keeps a once-daily sync backstop. Verify both under the repo's
   **Actions** tab (each can be run manually via "Run workflow").

### C · Domain (~15 min + DNS wait)
8. Vercel → Project → Settings → Domains → add `wholesale.drevifashion.com`.
9. At the DNS provider for drevifashion.com, add the CNAME Vercel shows
   (`wholesale` → `cname.vercel-dns.com`). HTTPS is automatic.
10. Supabase → Authentication → URL Configuration: set **Site URL** to
    `https://wholesale.drevifashion.com` (fixes forgot-password links).

### D · Data & messaging readiness
11. Sheet: fill wholesale columns; publish products in Shopify; flip
    `STRICT_FILTER = true` in `src/lib/sync.ts`; push (auto-deploys).
12. Interakt: submit the 5 templates for Meta approval (§10 of the spec), then add
    `INTERAKT_API_KEY` in Vercel and test one order confirmation to a real number.

### E · Production verification (the beta checklist)
13. Sync returns real counts (`curl -H "Authorization: Bearer $CRON_SECRET" https://wholesale.drevifashion.com/api/cron/sync-products`).
14. **Change all staff passwords** via /admin/staff (the seeded dev passwords are
    in chat history) and delete the test buyers/orders (Sharma Boutique,
    Verma Designs, Bloom & Co, Lotus Lane + DW/DX/IS test orders).
15. Onboard 2–3 real buyers (Case B), share credentials via WhatsApp, have them log in.
16. On a tablet over HTTPS: run a full in-store session — **camera QR scanning
    works now** — with tax + advance; check the invoice PDF and Share.
17. Airplane-mode an exhibition session mid-way; reconnect; confirm the queued
    order syncs.

### F · Afterwards
- `portal.sh` is no longer needed for uptime (Vercel is always-on); keep it for local dev.
- Future schema changes: add a migration file, run `npm run db:migrate` locally.
- Revoke the `SUPABASE_ACCESS_TOKEN` once you don't need migrations, or keep it for me.
- Running cost: **₹0/mo** (Vercel Hobby + Supabase Free + GitHub free).
  Upgrade paths when needed: Supabase Pro ~₹2,200/mo (managed backups + PITR,
  bigger limits, no-pause guarantee); Vercel Pro ~₹1,700/mo (commercial-use
  compliance, more compute) — both are one-click, zero code change.
- To restore from a backup artifact: download it from GitHub → Actions → the
  daily-backup run → `gunzip` → the JSON contains every table's rows; re-insert
  with the service role (ask Claude to script it if ever needed).
