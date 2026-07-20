# CLAUDE.md — Drevi Wholesale Portal

This file is read at the start of every Claude Code session. It is the persistent context for the Drevi Fashion wholesale portal. **Read it fully before any task.** When something here conflicts with your instinct, this file wins.

---

## What this is

A login-gated wholesale ordering portal for **Drevi Fashion** — premium Indo-western and contemporary ethnic wear, based in Dadar West, Mumbai. Approved wholesale buyers (boutique owners) log in, browse the catalog at wholesale prices, and submit order requests. Drevi staff also use it in person at exhibitions and in-store.

There is **no checkout and no payment processing**. Rakesh (Drevi's sourcing/wholesale lead) confirms each order and bills offline via Zoho Books. The portal is a gated catalog + order-request tool, not a storefront.

Two user flows share one codebase:
- **Remote buyer** — a vetted boutique owner browses on her phone, builds a cart, submits.
- **Exhibition** — Drevi staff on a tablet demo the catalog to a walk-up buyer and capture the order on the spot.

The authoritative product spec is `drevi-wholesale-portal-spec-v2.2.md` (in this repo's `/specs` folder). The locked visual design language is `drevi-wholesale-portal-catalog.jsx` (also in `/specs`). Read both before building UI.

---

## Golden rules (architecture invariants — never violate)

1. **Wholesale data lives in the Product Master Sheet, never in Shopify.** The fields `Final Wholesale` (price), `Wholesale Visible`, `Min Order Qty - Wholesale`, `Restockable`, and `Restock Days` live only in the Google Sheet. They are NEVER written to Shopify metafields. A Vercel cron syncs them into the Supabase `wholesale_products` table every 10 minutes. The portal reads from Supabase, never from the sheet at request time.

2. **Shopify is used ONLY to fetch product images during the sync.** Authenticate via the OAuth **Client Credentials Grant** — Shopify deprecated static admin (`shpat_`) tokens on Jan 1 2026. Never expect or ask for a static token. See "Shopify authentication" below.

3. **Secrets are server-only.** `SUPABASE_SERVICE_ROLE_KEY`, `SHOPIFY_CLIENT_SECRET`, and `PORTAL_PASSWORD_MASTER_KEY` must never reach client code, the browser bundle, or git history. Only `NEXT_PUBLIC_*` vars are client-safe.

4. **Buyer passwords are stored twice, in sync.** A bcrypt hash via Supabase Auth (authenticates login) AND an AES-256-GCM ciphertext in `buyers.encrypted_password` (lets Rakesh view/share/regenerate). Any password set or change updates both together. Login only ever touches the hash; admin view/share only ever touches the ciphertext.

5. **Audit everything credential-related.** Every create / view / regenerate / change / share / login event writes a row to `auth_audit_log`. Never write the password value itself to the log — only the event.

6. **Access control is enforced in the database.** Supabase row-level security: a buyer reads only their own orders and their own buyer row. Never rely on client-side filtering as the security boundary.

7. **The portal is invisible to the public.** `noindex, nofollow` meta tags, `robots.txt` disallows all, never linked from drevifashion.com or social. Buyers receive the URL from Rakesh directly.

---

## Architecture

```
Product Master Sheet (Google) ──┐
  wholesale fields + stock        │  Vercel cron, every 10 min
                                  ▼
                          Supabase: wholesale_products  ◄── portal reads here
                                  ▲
Shopify Admin API (CCG) ──────────┘
  product images only

Buyers / staff ──► Next.js (Vercel) ──► Supabase (auth, DB, storage)
                                    └──► Interakt (WhatsApp + email)
```

The SKU is the join key between sheet data and Shopify images. Sync logic: read sheet rows where `Shopify Live URL` is non-empty AND `Wholesale Visible = Y` AND `Final Wholesale > 0`; for each, upsert the wholesale fields into `wholesale_products`; for SKUs missing cached images (or older than 7 days), fetch image URLs from Shopify by product ID and cache them.

---

## Tech stack (locked — do not substitute)

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS with Royal Noir tokens
- Supabase: Postgres + Auth + Storage
- `googleapis` for Sheets reads
- `@react-pdf/renderer` for order PDFs (Phase 4)
- `idb` for IndexedDB / offline (Phase 4)
- `next-pwa` for the service worker (Phase 4)
- lucide-react for icons (match the prototype)
- Interakt API for WhatsApp + email
- Deployed on Vercel; cron via `vercel.json`

---

## Data model (Supabase)

Full DDL is in the spec Section 4. Tables:

- **buyers** — `id, email (unique, required), business_name, owner_name, phone, city, gstin, status (pending|active|suspended|rejected), source (inquiry_form|exhibition|manual_admin), encrypted_password, approved_by, approved_at, captured_by, captured_at, rejected_by, rejected_at, rejection_reason, notes, created_at`
- **orders** — `id, order_number (DW-… remote / DX-… exhibition), buyer_id, status (submitted|confirmed|fulfilled|cancelled), source (portal_self_service|exhibition), assisted_by, exhibition_event, items (jsonb), total_amount, notes, pdf_url, pdf_sent_via, pdf_sent_at, submitted_at, confirmed_at`
- **staff_users** — `id, email, name, role (super_admin|admin|staff), active, created_at`. Seed: ansh@ (super_admin), rakesh@ (admin), grishma@ (staff).
- **exhibition_sessions** — session analytics (Phase 4)
- **auth_audit_log** — `id, buyer_id, staff_user_id, event_type, event_at, ip_address, user_agent, notes`
- **wholesale_products** — read layer synced from the sheet: `sku (pk), title, description, category, sub_category, color, primary_fabric, wholesale_price, wholesale_visible, min_order_qty, restockable, restock_days, current_qty, image_urls (jsonb), shopify_product_id, shopify_live_url, synced_at, images_fetched_at`
- **shopify_tokens** — `id (pk default 'default'), access_token, expires_at, updated_at`. Caches the CCG token. Service-role only.

---

## Stock model (four states)

Computed once in `lib/stock.ts` via `getStockState(product)`, reused everywhere (catalog, detail, cart, PDF):

| current_qty | restockable | State | Orderable? | Qty cap |
|-------------|-------------|-------|-----------|---------|
| > 0 | true | **In Stock** (gold dot pill) | yes | none |
| > 0 | false | **Limited Edition · N left** (soft crimson pill) | yes | capped at current_qty |
| 0 | true | **Made to Order · Nd** (outlined gold pill) | yes | none |
| 0 | false | **Sold Out** (muted greige pill) | no (Add to Cart disabled) | — |

Quantity is otherwise never a barrier — restockable items accept any positive integer. MOQ (`min_order_qty`) is enforced per cart line: if set and the line qty is below it, block submission with helper text. Rakesh confirms all feasibility offline; the portal does not reserve stock.

---

## Design language (Royal Noir)

Match the catalog prototype exactly. Do not invent palette, type, or pill treatments.

- **Palette:** Rich Black `#1A1A1A`, Soft Black `#2D2926`, Antique Gold `#C4A35A`, Gold Deep `#A88848`, Warm Ivory `#FAF6F0`, Ivory Deep `#F2EBDC`, Champagne `#E8D5B7`, Crimson Soft `#FBEDEE`, Amber Soft `#FFF8E1`.
- **Type:** Playfair Display (product titles, prices, wordmark) · Montserrat (UI, pills, buttons, labels — uppercase + generous letter-spacing for utility text) · Cormorant Garamond reserved for brand moments only.
- **Cards:** 4:5 image ratio. Real images from `image_urls[0]`; fall back to the prototype's stylized gradient placeholder when empty.
- **Buttons:** solid black + ivory text for primary, outlined for secondary. No shouty CTAs — premium restraint.
- Configure all tokens in `tailwind.config.ts`. Load fonts via `next/font/google`.

---

## Environment variables

Stored in `.env.local` (gitignored — never commit). In Vercel, set the same as project env vars.

| Var | Scope | Purpose |
|-----|-------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | client | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Supabase admin key — bypasses RLS, server only |
| `PORTAL_PASSWORD_MASTER_KEY` | server | AES-256-GCM key for buyer password encryption |
| `CRON_SECRET` | server | Authenticates Vercel cron → sync endpoint |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | server | Path/JSON for Sheets read access |
| `GOOGLE_SHEET_ID` | server | Product Master Sheet ID |
| `SHOPIFY_STORE_DOMAIN` | server | drevifashion.myshopify.com |
| `SHOPIFY_CLIENT_ID` | server | Dev-dashboard app Client ID |
| `SHOPIFY_CLIENT_SECRET` | server | Dev-dashboard app Client Secret |
| `INTERAKT_API_KEY` | server | WhatsApp + email (Phase 4) |
| `SKU_REGISTRY_SHEET_ID` | server | Legacy SKU registry workbook (Phase 1 importer/mirror/floor) |
| `SKU_REGISTRY_TAB` | server | Registry tab name (default `SKUs`) |
| `SKU_DUAL_MODE` | server | `true` during the Apps-Script transition; `false` after retirement |

`lib/env.ts` validates presence of all required vars at startup and throws a descriptive error naming any that are missing.

---

## Shopify authentication (Client Credentials Grant)

Shopify deprecated static admin-created custom-app tokens on Jan 1 2026. The app is a Dev Dashboard app authenticated via OAuth client credentials. Build `lib/shopify-auth.ts` exporting `getShopifyAccessToken()`:

1. Read the cached token from `shopify_tokens` (single row, id='default'). If present and `expires_at` is more than 1 hour away, return it.
2. Otherwise POST to `https://{SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`
   - Header: `Content-Type: application/x-www-form-urlencoded`
   - Body (URLSearchParams, NOT JSON): `grant_type=client_credentials`, `client_id`, `client_secret`
3. Parse `{ access_token, expires_in }` (expires_in = 86399s). Upsert into `shopify_tokens` with `expires_at = now() + expires_in`. Return the new token.

All Admin API calls pass the token in the `X-Shopify-Access-Token` header. Use API version `2026-01` (or latest stable). On any 401, force-refresh once and retry before failing. Token is valid 24h; the 1-hour margin avoids mid-sync expiry.

Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant

---

## Security requirements

- RLS policies on `buyers`, `orders`, `wholesale_products`, `auth_audit_log` per spec Section 4.3. Client writes are never allowed; mutations go through server actions using the service role with explicit re-checks.
- Password encryption: AES-256-GCM with `PORTAL_PASSWORD_MASTER_KEY`. Encrypt/decrypt only in server routes gated to admin/super_admin role.
- Middleware on every route: authenticated + `buyers.status = active` for buyer routes; `staff_users.active = true` + role for `/admin/*`.
- Credential decrypt/view/share endpoints additionally check `role IN ('admin','super_admin')` and write an `auth_audit_log` row.

---

## Git workflow

- `main` is production (auto-deploys via Vercel).
- Work on feature branches per phase: `phase-1-foundation`, `phase-2-cart`, etc. Merge to `main` after the phase's verification passes.
- Commit in logical units with clear messages (e.g. `feat(sync): CCG token caching in shopify_tokens`). Never commit `.env.local` or any secret.
- `.gitignore` must include `.env*.local`, `node_modules`, `.next`, and any service-account JSON.

---

## Coding conventions

- TypeScript strict mode. No `any` unless genuinely unavoidable (comment why).
- Server-only modules import `server-only`. Never import the service-role client into a client component.
- Shared UI components live in `/components`, shared logic in `/lib`. The four-state pill, product card, product image, header, and filter chips are reusable across buyer, exhibition, and admin — build them generically with typed props.
- Use server actions for mutations, route handlers for the cron and webhooks.
- Show loading and empty states; never a blank screen on a slow query.
- Prose for users is in the Drevi voice: warm but spare. No emoji in UI chrome.

---

## Build phases

1. **Foundation** — scaffold, Supabase schema + RLS, sync pipeline (CCG + sheet → wholesale_products), buyer login, buyer catalog. Read-only.
2. **Buyer transactions** — cart (four-state qty rules + MOQ), order submission, order confirmation, order history.
3. **Admin + credentials** — Buyers tab, Buyer Detail, credential-setting modal, AES encryption, audit log, vCard, Case A/B/C onboarding flows.
4. **Exhibition + delivery + offline** — exhibition E1–E6, @react-pdf order PDF, Interakt sends, PWA service worker + IndexedDB offline queue + sync.

Each phase ends with explicit verification before the next begins. Do not pull later-phase work forward unless asked.

---

## Reference files (in /specs)

- `drevi-wholesale-portal-spec-v2.2.md` — authoritative spec. Sections: 4 (data model), 5 (roles), 6 (auth/onboarding), 7 (screens), 8 (offline), 9 (PDF), 10 (notifications).
- `drevi-wholesale-portal-catalog.jsx` — locked visual design language. Source of truth for palette, type, card layout, stock pills.

When in doubt about a UI detail, the prototype wins. When in doubt about a behavior or data rule, the spec wins. When in doubt about an architecture invariant, this file wins.
