# Drevi Wholesale Portal

A login-gated wholesale ordering portal for **Drevi Fashion**. Approved boutique
buyers browse the catalog at wholesale prices and submit order requests; Drevi
staff use the same catalog in-person at exhibitions. There is **no checkout and
no payment** — Rakesh confirms and bills offline via Zoho Books.

Architecture, golden rules, and design tokens live in [`CLAUDE.md`](./CLAUDE.md).
The authoritative product spec and the locked visual prototype are in
[`specs/`](./specs).

> **Status:** Phase 1 (Foundation) — project scaffold, Supabase schema + RLS, the
> Sheet → Supabase sync pipeline (Shopify Client Credentials Grant), buyer login,
> and the read-only buyer catalog. Cart, admin, exhibition, PDF, and offline
> arrive in Phases 2–4.

---

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind (Royal Noir tokens) · Supabase
(Postgres + Auth + RLS) · `googleapis` (Sheets) · Shopify Admin API · Vercel.

## Prerequisites

- Node 18.17+ (this repo is developed on Node via `nvm`).
- A Supabase project (URL + anon + service-role keys).
- A Google service-account JSON with **read** access to the Product Master Sheet.
- A Shopify Dev-Dashboard app with the Client Credentials Grant enabled
  (static `shpat_` tokens are deprecated — see `CLAUDE.md`).

## Environment

Copy your secrets into `.env.local` (gitignored — never commit). The full list
of variables and their scope is in `CLAUDE.md → Environment variables`. Every
required var is validated at runtime by `src/lib/env.ts`, which throws a
descriptive error naming any that are missing.

Database migration/seeding additionally needs the Supabase **direct connection
string** (ops-only, never committed):

```
SUPABASE_DB_URL=postgresql://postgres:[PASSWORD]@db.<ref>.supabase.co:5432/postgres
```

(Supabase dashboard → Project Settings → Database → Connection string → URI.)

## Local development

```bash
npm install
npm run dev          # http://localhost:3000  (redirects to /login)
```

### 1. Apply the database schema

```bash
npm run db:migrate   # applies supabase/migrations/*.sql via SUPABASE_DB_URL
```

This creates all tables, enums, RLS policies, and seeds the three staff rows
(`super_admin` / `admin` / `staff`). The migration is idempotent.

> No `SUPABASE_DB_URL`? You can also paste `supabase/migrations/0001_init.sql`
> into the Supabase **SQL editor** and run it there.

### 2. Create auth users (link to staff / buyer rows)

Login is **Supabase Auth** (email + password). App rows in `staff_users` and
`buyers` are linked to auth users **by email** — RLS matches the JWT's email
claim against these tables, so a buyer/staff row and its auth user simply share
the same email. The row's `id` is independent of the auth user id.

For local verification, seed dev auth users (staff + one active test buyer):

```bash
npm run db:seed-auth   # prints the dev credentials it sets
```

Real buyers are onboarded through the Phase 3 credential modal (which creates
the auth user and the encrypted password together). Real staff auth users are
created once in the Supabase dashboard (or via the Admin API) using the seeded
staff emails.

### 3. Sync products from the Master Sheet

```bash
# dev (no secret, dev only):
curl http://localhost:3000/api/dev/sync-now

# production cron equivalent:
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/sync-products
```

The sync reads the **Master** tab (2-row header, suffix-matched columns —
mirrors the AI pipeline), keeps rows where `Shopify Live URL` is set **and**
`Wholesale Visible = Y` **and** `Final Wholesale > 0`, upserts them into
`wholesale_products`, fetches Shopify product images for SKUs missing/stale
(>7 days) images, and hides SKUs that no longer qualify (without deleting, to
preserve order history). It returns `{ synced, image_fetches, hidden, skipped,
duration_ms, warnings }`.

## Deploy (Vercel)

1. Import the repo; set every variable from `CLAUDE.md → Environment variables`
   as Vercel project env vars (and `SUPABASE_DB_URL` only if you run migrations
   from CI/locally — it is not needed at runtime).
2. The cron in [`vercel.json`](./vercel.json) calls `/api/cron/sync-products`
   every 10 minutes, authenticated with `CRON_SECRET`.
3. Point `wholesale.drevifashion.com` at the Vercel project.

## Troubleshooting

**`/api/dev/sync-now` returns `0` or errors:**
- *"required Master columns not found"* — the sheet is missing one of
  `Drevi SKU`, `Shopify Live URL`, `Wholesale Visible`, `Final Wholesale`. The
  error lists the headers it *did* find; check spelling/section labels.
- *0 qualifying rows* — no row has `Shopify Live URL` set AND `Wholesale Visible
  = Y` AND `Final Wholesale > 0`. Confirm the wholesale columns are populated.
- *Sheets auth error* — `GOOGLE_SERVICE_ACCOUNT_JSON` points at the wrong file,
  or that service account hasn't been shared on the sheet (Viewer is enough).
- *Image fetches fail* — check the Shopify Dev app's Client ID/Secret and that
  the app has read access to products; the sync still upserts data without images.

**Login fails:**
- The buyer's auth user doesn't exist yet (run the credential flow / seed).
- The `buyers.status` isn't `active` (pending/suspended/rejected are blocked
  with a status-specific message).
- The auth user's email doesn't match the `buyers`/`staff_users` row email.

## Project structure

```
src/
  app/                 routes (login, catalog, admin, forgot-password, api/*)
  components/          StockPill, ProductImage, ProductCard, DreviHeader, FilterChips
  lib/                 env, stock, format, palette, sheets, sync, shopify-auth,
                       audit, supabase/{client,server,admin}
  middleware.ts        auth + status/role gating
supabase/migrations/   schema + RLS + seed
scripts/               db:migrate, db:seed-auth
```

## License

MIT — see [LICENSE](./LICENSE).
