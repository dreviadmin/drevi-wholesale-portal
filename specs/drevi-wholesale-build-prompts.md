# Drevi Wholesale Portal — Claude Code Build Prompts

Dispatch these to Claude Code one phase at a time, in order. Each phase ends with verification — confirm it passes before starting the next. All four assume `CLAUDE.md` is at the repo root and the `/specs` folder contains `drevi-wholesale-portal-spec-v2.2.md` and `drevi-wholesale-portal-catalog.jsx`.

Run Claude Code from inside `/Users/anshsarawagi/Documents/drevi/wholesale-portal/` for all phases. You place `CLAUDE.md` and the `specs/` folder into that directory yourself before dispatching; Phase 1 scaffolds the Next.js app into the directory around those existing files.

---

## Execution protocol (read this first)

These four phases can be run autonomously, one after another, in a single session. For each phase, in order:

1. **Build** everything in the phase's BUILD section.
2. **Verify for real** — run that phase's VERIFY checklist by actually doing it: start the dev server, hit the dev sync route, query Supabase, log in as a test buyer, etc. Do not assume a step passes; check it.
3. **If every verification step passes:** commit to git with a clear message (e.g. `Phase 1: foundation — sync pipeline, auth, catalog`), then proceed to the next phase.
4. **If any verification step fails:** STOP. Do not proceed to the next phase. Report which check failed, what you tried, and your best diagnosis. A broken earlier phase makes every later phase wasted work — this gate is the entire reason the phases are separated.

Each phase's git commit is a rollback checkpoint; treat them as such. Never force through a failing verification with "I'll fix it later." If something is genuinely ambiguous and CLAUDE.md, the spec, and the prototype don't resolve it, make a reasonable decision, note it clearly in your end-of-phase report, and keep moving — don't block on it.

---

## PHASE 1 — Foundation

```
Read CLAUDE.md and the two files in ./specs (drevi-wholesale-portal-spec-v2.2.md and drevi-wholesale-portal-catalog.jsx) before writing any code. CLAUDE.md is authoritative for architecture; the spec for behavior; the prototype for visual design.

GOAL
Build the foundation of the Drevi Wholesale Portal: project scaffold, Supabase schema + RLS, the Sheet→Supabase sync pipeline (with Shopify Client Credentials Grant auth), buyer login, and the buyer catalog reading live synced data. At the end I should be able to: create a buyer in Supabase, log in, and see the catalog populated from the Product Master Sheet with correct stock pills, real prices, and real images.

REPO
You're running from inside ./ which is /Users/anshsarawagi/Documents/drevi/wholesale-portal/. This directory already exists and already contains CLAUDE.md and a specs/ folder — these are intentional; never delete or overwrite them. Scaffold the Next.js app into this existing directory, preserving those files. If create-next-app refuses because the directory is non-empty (CLAUDE.md and specs/ are not on its safe-list), scaffold into a temporary directory and merge the output in, OR temporarily move CLAUDE.md and specs/ aside, scaffold, then move them back. CLAUDE.md must end up at the repo root; specs/ must remain a top-level folder. Init git, add .gitignore (.env*.local, node_modules, .next, *.json service accounts), MIT license, and a thorough README.

ENV
.env.local is already populated with all variables listed in CLAUDE.md → Environment variables. Build lib/env.ts to validate them at startup and fail with a descriptive error naming any missing var. Do NOT hardcode any secret anywhere.

BUILD (in this order, test each before moving on)

1. Scaffold: create-next-app (TypeScript, Tailwind, App Router, src dir, @/* alias). Configure tailwind.config.ts with the full Royal Noir token set from CLAUDE.md. Wire next/font/google for Playfair Display, Cormorant Garamond, Montserrat as CSS variables on <html>.

2. Supabase migration (supabase/migrations/): create all tables per spec Section 4.3 — buyers, orders, staff_users, exhibition_sessions, auth_audit_log, wholesale_products, shopify_tokens. Seed staff_users with the three accounts (super_admin/admin/staff). Add the README note on linking these rows to Supabase auth.users IDs.

3. RLS policies per CLAUDE.md → Security and spec 4.3: wholesale_products readable by any active buyer or active staff; buyers/orders readable only by the owning buyer or staff; auth_audit_log readable by admin/super_admin; no client writes anywhere.

4. lib/shopify-auth.ts → getShopifyAccessToken() implementing the Client Credentials Grant exactly as in CLAUDE.md → Shopify authentication, caching in shopify_tokens with the 1-hour refresh margin and single-retry on 401.

5. Sync pipeline at app/api/cron/sync-products/route.ts (Vercel cron, */10 * * * * in vercel.json, bearer-auth against CRON_SECRET):
   - Read the Master tab via googleapis.
   - Filter rows: Shopify Live URL non-empty AND Wholesale Visible = "Y" AND Final Wholesale > 0.
   - Map sheet columns → wholesale_products fields (CLAUDE.md data model). restockable = (Restockable == "Y"); restock_days = integer or null; min_order_qty = integer or null; current_qty from Current Qty.
   - Validation: if Restockable="Y" and Restock Days blank → log warning, skip row. If Final Wholesale 0/blank → skip. If sheet returns 0 rows → fail loudly.
   - For SKUs with empty image_urls or images_fetched_at older than 7 days: call Shopify Admin API (via getShopifyAccessToken) by Shopify Product ID, extract image src URLs in order, cache them.
   - Upsert keyed on sku. For SKUs previously synced but no longer in the filtered set, set wholesale_visible = false (don't delete — preserves order history).
   - Return JSON { synced, image_fetches, hidden, duration_ms }.
   - Also add a dev-only route app/api/dev/sync-now/route.ts (no cron-secret check, only when NODE_ENV !== 'production') for manual testing from the browser.

6. Extract reusable components from the prototype into /components (typed props): StockPill, ProductImage, ProductCard, DreviHeader, FilterChips. lib/stock.ts holds getStockState().

7. Buyer login at app/login/page.tsx: email + password via Supabase Auth, "Forgot Password" link. After success, check buyers.status — active → /catalog; pending/suspended/rejected → sign out with the spec's status-specific message. If the email is a staff_user → /admin (placeholder "coming soon" page for now). Log every attempt (success + failure) to auth_audit_log.

8. middleware.ts: gate /catalog, /cart, /account behind auth + buyers.status='active'; gate /admin/* behind staff_users.active + role (placeholder UI for now); public routes /, /login, /forgot-password, /api/cron/*, /api/dev/*.

9. Buyer catalog at app/catalog/page.tsx: replicate the prototype's Buyer/Mobile treatment with real data from wholesale_products. Top bar, "WHOLESALE CATALOG · {business_name}" sub-bar, dynamic category chips, responsive grid (2 col mobile / 3 tablet / 4 desktop). Use StockPill (four states) and ProductCard. Add-to-Cart is rendered but non-functional this phase (toast "Cart coming in Phase 2"); disabled for sold_out.

10. README: prerequisites, local dev (npm install && npm run dev), how to link Supabase auth users to staff/buyer rows, how to trigger /api/dev/sync-now, Vercel deploy steps, troubleshooting (sync returns 0 rows, login fails).

VERIFY before declaring done
1. npm run dev starts clean, no missing-env warnings.
2. Hitting /api/dev/sync-now returns { synced: N } matching the count of qualifying sheet rows.
3. Supabase wholesale_products table is populated; image_urls present for synced SKUs.
4. A manually-created active buyer can log in at /login.
5. /catalog renders real products, real images, correct four-state pills.
6. Middleware blocks /catalog for an unauthenticated request.
7. shopify_tokens has a cached token with a future expires_at.

OUT OF SCOPE (later phases): cart, order submission, admin UI, credential management, exhibition, PDF, Interakt, PWA/offline. The encrypted_password column exists but is unused this phase.

When all 7 verification steps pass, report what passed, any anomalies, and any judgment calls you made.
```

---

## PHASE 2 — Buyer transactions

```
Read CLAUDE.md and specs/drevi-wholesale-portal-spec-v2.2.md (Section 7 Part A) before starting. Phase 1 is complete and merged. Branch: phase-2-cart.

GOAL
Make the buyer flow transactional: cart, quantity rules, MOQ enforcement, order submission, confirmation, and order history. No PDF or WhatsApp yet (Phase 4) — submission just writes the order and shows a confirmation.

BUILD
1. Cart state: a client-side cart (React context + in-memory; NO localStorage per artifact rules — but this is a real app, so use a normal client store like Zustand or React context persisted to a cart row in Supabase keyed to the buyer). Decide and document the choice; Supabase-persisted cart is preferred so a buyer's cart survives device switches.
2. Add-to-Cart wiring on catalog + product detail. Quantity rules from CLAUDE.md → Stock model: restockable items unbounded; Limited Edition capped at current_qty with helper text; Sold Out cannot be added.
3. Product detail view (modal or page) with image gallery, full description, fabric, stock pill, quantity selector respecting MOQ (Add disabled below min_order_qty with "Minimum N pieces" helper).
4. Cart screen (app/cart): line items, qty editing, per-line MOQ enforcement (red helper + Submit disabled below minimum), subtotal, optional buyer note, "Submit Order Request" button. Out-of-stock-but-restockable items show "Made to Order · Nd" inline.
5. Order submission: server action that writes an orders row (status submitted, source portal_self_service, order_number DW-YYYYMMDD-###, items jsonb snapshot including each line's stock state at submission time, total_amount). Clear the cart.
6. Confirmation screen app/order/[id]: order number, total, max lead-time summary across items ("Estimated availability: N days"), next-steps copy. PDF status placeholder ("confirmation sent" wiring comes in Phase 4).
7. Order history app/account/orders: table of the buyer's orders (date, number, total, status), click into any for full detail. RLS already restricts to own orders — verify it does.

VERIFY
1. Buyer can add a restockable item with any qty; Limited Edition caps at stock; Sold Out can't be added.
2. A line below its MOQ blocks submission with clear helper text; meeting MOQ unblocks it.
3. Submitting writes a correct orders row (check Supabase) and shows the confirmation with the right lead-time summary.
4. Order history shows only this buyer's orders; a second test buyer cannot see them.
5. Cart survives a page reload (and device switch if Supabase-persisted).

Report results, anomalies, and the cart-persistence decision you made.
```

---

## PHASE 3 — Admin + credentials

```
Read CLAUDE.md (Security, data model) and spec Sections 5, 6, 7 Part C before starting. Phases 1–2 complete. Branch: phase-3-admin.

GOAL
Build Rakesh's admin: Buyers tab, Buyer Detail, the credential-setting modal, AES-256-GCM password encryption with audit logging, vCard export, and the three onboarding paths (Case A inquiry approval, Case B manual add, Case C exhibition-capture approval).

BUILD
1. lib/crypto.ts: AES-256-GCM encrypt/decrypt using PORTAL_PASSWORD_MASTER_KEY, server-only, used only by admin-gated routes. Unit-test the round-trip.
2. lib/audit.ts: writeAuditEvent() helper for all auth_audit_log writes (never logs the password value).
3. Admin shell at /admin: sidebar (Buyers, Orders, Exhibitions [stub], Audit Log, Staff [super_admin only]), role-gated. Replace the Phase 1 placeholder.
4. Buyers tab: table (business, owner, phone w/ WhatsApp link, city, status pill, source pill, orders count, last order, created), search (business/owner/phone/email), status + source filters, "+ Add Buyer" button, pending-count badge.
5. Buyer Detail: header with status dropdown (active/suspend/reject with confirms; reject is destructive), Send Login Link via WhatsApp, Save to Contacts, ⋯ menu. Credentials section: email shown; password masked with reveal (decrypts via admin route, logs credential_viewed); Copy / Share via WhatsApp / Regenerate (confirm modal, new memorable password, updates hash + ciphertext, logs) / Change (inline form). Order history, notes, activity log sections.
6. Credential-setting modal (the convergence point for all three onboarding paths): email field (prefilled, editable), password section (auto-generate memorable {Word}-{Word}-{4digits} default, or custom), "Send email" + "Open WhatsApp share" checkboxes. On Save & Activate: bcrypt→Supabase Auth, AES→encrypted_password, status→active, set approved_by/at, log credential_created, fire selected sends.
7. WhatsApp share: build the OS-share-sheet message exactly per spec Section 6.5; open via the Web Share API where available, fall back to a wa.me link. Log credential_shared with the channel.
8. vCard: "Save to Contacts" downloads a .vcf per spec Section 7.6 (FN = "Owner (Business)").
9. Onboarding paths: Case A — public /wholesale inquiry creates a pending/inquiry_form buyer (build the inquiry form too, or stub it and document); admin Approve → credential modal, Reject → rejected + reason. Case B — "+ Add Buyer" form (business/owner/email/phone/city/gstin/notes) → pending/manual_admin → straight to credential modal. Case C — exhibition captures (Phase 4) land as pending/exhibition and approve identically.
10. Orders tab: cross-buyer order table with source/status/date filters; order detail with confirm/fulfil/cancel actions. Audit Log tab: read-only filtered view.

VERIFY
1. Encryption round-trips; a revealed password matches what was set.
2. Regenerate produces a new working password, invalidates the old, logs the event.
3. Every credential action appears in auth_audit_log with correct staff attribution; no password values in the log.
4. WhatsApp share opens with the correctly formatted message; vCard imports cleanly on a phone.
5. Case B: add a buyer → set credentials → that buyer logs in successfully.
6. Suspending a buyer blocks their next page load; reactivating restores access.
7. A staff (non-admin) role cannot reach credential routes.

Report results, anomalies, and judgment calls.
```

---

## PHASE 4 — Exhibition, PDF delivery, offline

```
Read CLAUDE.md and spec Sections 7 Part B, 8 (offline), 9 (PDF), 10 (notifications). Phases 1–3 complete. Branch: phase-4-exhibition.

GOAL
Exhibition mode (E1–E6), branded order PDF via @react-pdf/renderer, Interakt sends (buyer PDF + Rakesh alerts + welcome email), and the PWA offline layer (service worker, IndexedDB catalog cache, queued submissions, sync on reconnect).

BUILD
1. Exhibition flow under /admin/exhibition/* (staff-gated), tablet-first per spec Part B: E1 home, E2 start session (event name + catalog prefetch), E3 buyer select/new-buyer-capture (creates pending/exhibition), E4 catalog (reuse ProductCard/StockPill; add the wholesale-price visibility toggle), E5 cart (same rules as buyer cart; staff/buyer notes), E6 confirmation (PDF status, next-buyer / end-session).
2. @react-pdf/renderer order PDF per spec Section 9 (Royal Noir branded, items table with each line's stock state, lead-time note, contact). Upload to Supabase Storage, store signed URL in orders.pdf_url.
3. Interakt integration: five templates (wholesale_inquiry_alert, wholesale_pending_review, wholesale_order_alert to Rakesh; wholesale_welcome_email, wholesale_order_confirmation w/ PDF media to buyer). On order submit (both flows), generate PDF → upload → send via Interakt → log pdf_sent_via/at. Graceful fallback to "Download PDF" if the send fails.
4. PWA: next-pwa config + service worker. On exhibition session start, prefetch all active products + images into IndexedDB (progress UI). Offline: serve catalog from cache with timestamp caveat; queue order submissions and new-buyer captures in IndexedDB; on reconnect, drain the queue in order (buyer insert → order insert → PDF → Interakt), exponential backoff, surface failures with a Resend button.
5. Stock-time caveat in exhibition mode per spec 8.4 ("as of HH:MM").

VERIFY
1. A full exhibition session works online: start → new buyer → build cart → submit → PDF generated → WhatsApp delivered.
2. Airplane-mode mid-session: catalog still browsable from cache, submission queues, and on reconnect it syncs cleanly (buyer + order created, PDF sent).
3. PDF renders one page with all four stock states represented correctly and Royal Noir branding intact.
4. Interakt sends succeed to a real Indian number for all relevant templates; failures fall back to Download PDF.
5. Exhibition orders carry source=exhibition, assisted_by, exhibition_event; Rakesh's alert shows "Source: Exhibition".

Report results, anomalies, and judgment calls. This completes the portal MVP.
```

---

## After each phase

Paste the phase's verification results back into our chat. If anything's off or a judgment call needs a second opinion, that's the moment to course-correct before the next phase builds on top. I'll refine the next phase's prompt against the actual codebase Claude Code produced, rather than against assumptions.
