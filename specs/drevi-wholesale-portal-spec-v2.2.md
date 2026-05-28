# DREVI FASHION — Wholesale Portal
## Technical Specification v2.2
**May 2026 | Internal Document | Supersedes v2.1**

---

## What's new in v2.2

Four substantive changes informed by how Drevi's wholesale relationships actually work — Rakesh is the trust gradient, not the portal itself.

1. **Stock display becomes per-SKU intelligence, not a global toggle.** Two new metafields on every product — `restockable` (boolean) and `restock_days` (integer, nullable) — combine with live stock count to produce four meaningful states surfaced as distinct pills: *In Stock*, *Limited Edition (X left)*, *Made to Order (Xd)*, *Sold Out*. The v2.1 `display_stock_quantity` global setting and the `portal_settings` table are removed — this model is more honest and removes a setting Rakesh would have had to manage.

2. **Unified buyer pipeline with Rakesh-controlled credentials.** Buyers arrive from three sources (public inquiry form, exhibition capture, manual admin add) and converge on a single status pipeline. Rakesh approves (or auto-creates in the manual case), then sets credentials in a unified modal. Email is the username, phone drives WhatsApp share, and password is **stored encrypted-at-rest** so Rakesh can see/share/change it at any time. No "set your own password" emails for the buyer — Rakesh gives them their credentials directly.

3. **WhatsApp credential share + save-to-contacts.** The credential modal and every buyer detail page expose a "Share via WhatsApp" action that opens the OS share sheet with a pre-formatted message. A separate "Save to Contacts" button downloads a vCard so Rakesh's WhatsApp address book stays in sync with the buyer list.

4. **Auth audit log.** Every credential event (created / viewed / regenerated / changed / shared / login_success / login_failed) is written to an `auth_audit_log` table with the staff user, timestamp, and IP. This is non-negotiable when passwords are visible to admins — it converts a security concern into a manageable governance question.

Everything else from v2.0 and v2.1 stays: exhibition mode, offline cache, PDF + Interakt order confirmation, staff roles, MOQ from sheet, no-stock-barrier cart, design tokens from the catalog prototype.

---

## 1. Purpose

A standalone, login-gated web application serving two flows on a shared product catalog:

**Flow A — Remote wholesale:** Rakesh's approved buyers log in from anywhere, browse with wholesale pricing, submit order requests. Rakesh confirms and bills offline.

**Flow B — Exhibition / in-person:** Drevi staff (Rakesh or Grishma) log in on a tablet at a trade show or in-store, walk a buyer through the catalog, capture buyer details if new, build a cart together, submit, and send a branded PDF order summary to the buyer's WhatsApp on the spot.

Both flows write to the same `orders` table. From Rakesh's processing side, every order looks the same — just tagged by `source` and `assisted_by` for reporting. Billing always happens offline via Zoho Books.

This portal is Drevi's primary wholesale channel and a key differentiator: every other Dadar wholesaler relies on phone calls and WhatsApp photos; Drevi offers professional AI photography, transparent pricing, self-serve restock ordering, and a digital-first exhibition experience — all gated behind Rakesh's vetting.

---

## 2. Architecture Overview

```
┌─────────────────────┐        ┌────────────────────────────────────┐
│   Shopify Store     │        │   Wholesale Portal (Next.js PWA)   │
│   (drevifashion.com)│        │   wholesale.drevifashion.com       │
│                     │        │                                    │
│  • Retail e-commerce│◄──────►│  ┌─────────────┐ ┌──────────────┐  │
│  • MRP pricing      │  API   │  │ Buyer flow  │ │ Staff flow   │  │
│  • /wholesale page  │        │  │ /catalog    │ │ /admin       │  │
│  • Product master   │        │  │ /cart       │ │ /exhibition  │  │
│  • restockable +    │        │  └─────────────┘ └──────────────┘  │
│    restock_days     │        │         │             │            │
│  • Inventory truth  │        │         ▼             ▼            │
└─────────────────────┘        │  ┌──────────────────────────────┐  │
                               │  │ Service Worker + IndexedDB   │  │
                               │  │ (offline catalog + queue)    │  │
                               │  └──────────────────────────────┘  │
                               └────────────┬───────────────────────┘
                                            │
                       ┌────────────────────┼────────────────────┐
                       ▼                    ▼                    ▼
              ┌──────────────────┐ ┌──────────────────┐ ┌─────────────────┐
              │  Supabase        │ │  Interakt        │ │  OS share sheet │
              │  • buyers        │ │  WhatsApp        │ │  (client-side)  │
              │  • orders        │ │  • notify Rakesh │ │  • credential   │
              │  • staff_users   │ │  • send PDF      │ │    share        │
              │  • auth_audit_log│ │    to buyer      │ │  • vCard import │
              │  • Storage (PDF) │ │                  │ │                 │
              │  Auth + RLS      │ │                  │ │                 │
              └──────────────────┘ └──────────────────┘ └─────────────────┘
                                            │
                                            ▼ (offline, by Rakesh)
                                  ┌──────────────────────┐
                                  │  Zoho Books          │
                                  │  Pakka / Kachha      │
                                  │  billing             │
                                  └──────────────────────┘
```

**Key principle:** Products live ONLY in Shopify. The portal is a read-only window into the same catalog with a different price layer, a different action, and a different access gate. Rakesh is the trust gradient — the portal enforces what Rakesh has decided, it doesn't make decisions about who is allowed in.

---

## 3. Tech Stack

| Layer | Technology | Cost |
|-------|-----------|------|
| Framework | Next.js (App Router) | Free |
| PWA / offline | `next-pwa` + custom service worker | Free |
| Local storage | IndexedDB via `idb` library | Free |
| Hosting | Vercel (free tier) | ₹0/month |
| Domain | `wholesale.drevifashion.com` (subdomain) | included in existing domain |
| Authentication | Supabase Auth (email + password) | ₹0/month (free tier — up to 50,000 MAUs) |
| Database | Supabase PostgreSQL | ₹0/month (free tier — 500MB) |
| File storage (PDFs) | Supabase Storage | ₹0/month (free tier — 1GB) |
| Password encryption | AES-256-GCM, master key in Vercel env vars | Free |
| Product data | Shopify Storefront API (GraphQL) | Included in Shopify Basic |
| Wholesale pricing | Shopify metafields per product | No extra cost |
| Buyer / staff notifications | Interakt WhatsApp + email fallback | Existing Interakt plan |
| Buyer PDF delivery | Interakt WhatsApp media template | Same Interakt plan |
| PDF generation | `@react-pdf/renderer` (client-side) | Free |
| vCard generation | Pure JS, client-side (no library) | Free |
| Styling | Tailwind CSS, Royal Noir tokens | Free |

**Total incremental monthly cost: ₹0** — everything piggybacks on Vercel, Supabase, and Interakt free/existing tiers.

---

## 4. Data Model

### 4.1 Shopify Product (source of truth)

Each product in Shopify contains the canonical fields plus a small set of wholesale-portal metafields. All four metafields are sourced from the Product Master Sheet — no direct Shopify editing needed for portal data.

**Metafields read by the portal:**

| Metafield | Type | Source (sheet column) | Purpose |
|-----------|------|----------------------|---------|
| `custom.wholesale_price` | number | Wholesale Price | The price shown on the portal |
| `custom.wholesale_visible` | boolean | Wholesale Visible (default Y) | Whether to display on the portal |
| `custom.min_order_qty` | number, nullable | Min Order Qty - Wholesale | MOQ enforced per cart line |
| `custom.restockable` | boolean | **Restockable (new in v2.2)** | Whether this design can be reordered from supplier |
| `custom.restock_days` | integer, nullable | **Restock Days (new in v2.2)** | Lead time when restockable; required if restockable = true |

### 4.2 Product Master Sheet → Shopify propagation

New columns added to the Product Master Sheet in v2.2:

| Column | Filled by | Validation |
|--------|-----------|------------|
| Restockable | Rakesh | Y or N (required) |
| Restock Days | Rakesh | Integer ≥ 1 if Restockable = Y; blank if Restockable = N |

**Pipeline validation:**
- If Restockable = Y and Restock Days is blank → pipeline rejects with error: `SKU {sku}: restockable but no restock_days set`
- If Restockable = N and Restock Days is filled → pipeline warns but accepts (treats restock_days as N/A)
- If Restockable is blank → pipeline rejects (STRICT_SPEC_MODE — no default)

The four-state stock model derives from these two fields plus live inventory:

| Live stock | Restockable | Display state | Orderable? | Qty cap |
|-----------|-------------|---------------|-----------|---------|
| > 0 | Yes | **In Stock** (gold dot pill) | Yes | None |
| > 0 | No | **Limited Edition · {stock} left** (soft crimson pill) | Yes | Capped at current stock |
| 0 | Yes | **Made to Order · {restock_days}d** (outlined gold pill) | Yes | None |
| 0 | No | **Sold Out** (muted greige pill) | No (Add to Cart disabled) | — |

This logic is implemented once in a `getStockState(product)` helper and reused across catalog, product detail, cart, and PDF.

### 4.3 Supabase tables

**Table: `buyers`** (revised in v2.2)

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| email | text | Login credential, unique, **required** (it's the username) |
| business_name | text | e.g., "Sharma Boutique" |
| owner_name | text | Buyer's name |
| phone | text | WhatsApp number — required, used for credential share & PDF delivery |
| city | text | e.g., "Pune" |
| gstin | text | nullable — not all buyers have GST |
| status | enum | `pending`, `active`, `suspended`, `rejected` (revised in v2.2) |
| source | enum | `inquiry_form`, `exhibition`, `manual_admin` |
| encrypted_password | bytea | AES-256-GCM ciphertext of the buyer's plaintext password. Decrypted only by admin server routes. Stored alongside Supabase Auth's password hash, which is what authenticates the actual login. |
| approved_by | uuid | FK → staff_users.id, nullable |
| approved_at | timestamp | When status moved to active |
| captured_by | uuid | FK → staff_users.id, nullable (set for exhibition captures) |
| captured_at | timestamp | When the buyer row was created |
| rejected_by | uuid | FK → staff_users.id, nullable |
| rejected_at | timestamp | When status moved to rejected |
| rejection_reason | text | nullable, free text |
| notes | text | Internal notes |
| created_at | timestamp | Auto |

**Status meanings:**

| Status | Meaning | Can log in? |
|--------|---------|-------------|
| `pending` | Captured (from any source) but not yet approved | No |
| `active` | Approved by Rakesh, has credentials | Yes |
| `suspended` | Was active, now disabled — credentials retained | No |
| `rejected` | Disapproved by Rakesh — soft-deleted, retained for audit | No |

`pending_verification` from v2.1 is collapsed into `pending` — the `source` field now disambiguates inquiry-form pending from exhibition pending. Cleaner.

**Why encrypted_password exists alongside Supabase Auth's hash:** Supabase Auth stores a bcrypt hash that's used to authenticate logins. That hash is one-way and can never be retrieved. The `encrypted_password` column stores the *plaintext password encrypted at rest* with a master key — this is what lets Rakesh view and share credentials at any time. Both are kept in sync: when a password is set or changed, the new value goes through bcrypt (for auth) AND AES-256-GCM (for sharing). When a buyer logs in, only the hash is touched. When Rakesh wants to share, only the encrypted copy is touched. They never cross paths in production code.

**Master key management:**
- Stored as Vercel environment variable `PORTAL_PASSWORD_MASTER_KEY` (32 bytes, base64-encoded)
- Generated once, at portal setup, by Ansh
- Backed up to Ansh's password manager (1Password or similar)
- Accessible only to authenticated server routes for admin and super_admin roles
- Never logged, never returned to the client, never sent over any channel except via decrypted output to the admin UI on explicit request

**Table: `orders`** — unchanged from v2.1.

**Table: `staff_users`** — unchanged from v2.1.

**Table: `exhibition_sessions`** — unchanged from v2.1.

**Table: `auth_audit_log` (new in v2.2)**

Every credential-related event is logged here. Non-negotiable when passwords are admin-visible.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| buyer_id | uuid | FK → buyers, nullable (null for failed logins with unknown email) |
| staff_user_id | uuid | FK → staff_users, nullable (null for buyer self-actions) |
| event_type | enum | `credential_created`, `credential_viewed`, `credential_regenerated`, `credential_changed`, `credential_shared`, `login_success`, `login_failed`, `account_suspended`, `account_reactivated`, `account_rejected` |
| event_at | timestamp | Auto |
| ip_address | text | nullable |
| user_agent | text | nullable |
| notes | text | nullable — e.g., for `credential_shared`: which channel ("WhatsApp", "Email", "Copy") |

Importantly: the password value itself is never written to this table. Only the *event* of accessing it.

**Table: `portal_settings`** — **removed in v2.2.** The `display_stock_quantity` setting it held is obsoleted by the per-SKU restockable model. If future global settings are needed, the table can be re-added at that time.

---

## 5. Roles & Access Control

| Capability | Buyer | Staff (Grishma) | Admin (Rakesh) | Super Admin (Ansh) |
|------------|:-----:|:---------------:|:--------------:|:------------------:|
| Login to `/catalog` (remote flow) | ✓ | — | — | — |
| Browse & build personal cart | ✓ | — | — | — |
| Submit own order | ✓ | — | — | — |
| View own past orders | ✓ | — | — | — |
| Login to `/admin` | — | ✓ | ✓ | ✓ |
| Start Exhibition Session | — | ✓ | ✓ | ✓ |
| Capture new buyer at exhibition (status: pending, source: exhibition) | — | ✓ | ✓ | ✓ |
| Build & submit order on behalf of buyer | — | ✓ | ✓ | ✓ |
| Generate & WhatsApp the PDF | — | ✓ | ✓ | ✓ |
| View Buyers tab | — | — | ✓ | ✓ |
| Approve / reject pending buyers | — | — | ✓ | ✓ |
| Add buyer manually (Case B) | — | — | ✓ | ✓ |
| Set / change / view / share credentials | — | — | ✓ | ✓ |
| Save buyer to contacts (download vCard) | — | — | ✓ | ✓ |
| Suspend / reactivate buyers | — | — | ✓ | ✓ |
| View all orders (any source) | — | — | ✓ | ✓ |
| Update order status (confirm / fulfil / cancel) | — | — | ✓ | ✓ |
| Set wholesale prices (Shopify metafields) | — | — | ✓ | ✓ |
| View auth audit log | — | — | ✓ | ✓ |
| Add / deactivate staff users | — | — | — | ✓ |

Grishma can capture buyers at exhibitions but cannot approve them — every credential moment runs through Rakesh. This protects the wholesale relationship from accidental over-grants while keeping exhibition speed where it matters (capturing the lead).

Enforcement: middleware on every `/admin` route checks the staff_user role from Supabase Auth claims. Server actions also re-check on every mutation. Credential-management endpoints additionally check `role IN ('admin', 'super_admin')`.

---

## 6. Authentication & Buyer Onboarding

Three onboarding paths converge on a single credential-setting moment.

### 6.1 Case A — Inquiry-driven onboarding

1. Boutique owner finds drevifashion.com/wholesale (public, SEO-indexed page on the retail site)
2. Fills inquiry form: business name, owner name, email, phone, city, gstin (optional), interested categories (optional), message (optional)
3. Backend creates a `buyers` row with `status: pending`, `source: inquiry_form`
4. Rakesh receives a WhatsApp + email notification via Interakt: "New wholesale inquiry from {business}"
5. Rakesh opens `/admin/buyers`, filters by `pending`, reviews the inquiry
6. Rakesh decides:
   - **Approve** → opens the credential-setting modal (Section 6.4)
   - **Reject** → sets `status: rejected`, captures a reason, no further communication is sent
   - **Defer** → leaves as pending, decides later

### 6.2 Case B — Manual admin add (in-store, known buyer)

1. Buyer is physically present (Dadar shop walk-in, or Rakesh entering a long-known relationship for the first time)
2. Rakesh taps "+ Add Buyer" in `/admin/buyers`
3. Form: business name, owner name, email, phone, city, gstin (optional), notes (optional)
4. On save, status goes directly to `pending` and the credential-setting modal opens immediately — no approve step, since Rakesh is the one creating the row

This skips the queue but still lands the buyer in the audit trail with `source: manual_admin`.

### 6.3 Case C — Exhibition capture (Section 7 Part B)

1. During an exhibition session, Grishma or Rakesh captures buyer details on the tablet (Screen E3)
2. Buyer row created with `status: pending`, `source: exhibition`, `captured_by: staff_user.id`
3. **No credentials set, no welcome sent** — the buyer leaves the exhibition without portal access
4. After the event, Rakesh reviews exhibition captures (filter `source: exhibition AND status: pending`) and either approves (opens credential modal) or rejects

This protects the wholesale relationship from a stranger Rakesh hasn't yet vetted gaining portal access on the strength of a five-minute booth conversation.

### 6.4 The credential-setting modal

The single screen that all three onboarding paths converge on. Opened by tapping "Approve" (Cases A, C) or "Save & Set Credentials" (Case B).

```
─────────────────────────────────────────────
  SET CREDENTIALS
  Sharma Boutique · Meera Sharma · Pune

  Username (email)
  [ meera@sharma-boutique.com           ]
  This is what they'll use to log in.

  Password
  ◉ Auto-generate a memorable password
  ○ Set a custom password

  Generated: Tulip-Lotus-7382       [↻ Regenerate]

  ─────────────────────────────────────

  After saving:
  ☑ Send email with credentials (audit trail)
  ☑ Open WhatsApp share sheet for Rakesh

  [ Cancel ]                    [ Save & Activate ]
─────────────────────────────────────────────
```

**Behavior:**
- Email is pre-filled from the buyer record; can be edited if Rakesh notices a typo
- Password section defaults to auto-generate (memorable format: `{Word}-{Word}-{4digits}` from the EFF wordlist — pronounceable, 12+ characters, secure entropy)
- Custom password option reveals a text input with show/hide eye toggle
- The "Send email" and "Open WhatsApp share" checkboxes default to both ON; Rakesh can uncheck either
- **On Save & Activate:**
  1. Password is hashed via bcrypt and stored via Supabase Auth (so it actually works for login)
  2. Password is also encrypted via AES-256-GCM with the master key and stored in `buyers.encrypted_password`
  3. Buyer status moves to `active`, `approved_by` and `approved_at` are set
  4. `auth_audit_log` event: `credential_created`
  5. If "Send email" checked: Interakt template `wholesale_welcome_email` fires
  6. If "Open WhatsApp share" checked: returns to the buyer detail page with the OS share sheet pre-opened (Section 6.5 for message format)

### 6.5 WhatsApp share message format

When Rakesh taps "Share via WhatsApp" (from the credential modal or any buyer detail page), the OS share sheet opens with this message pre-populated:

```
Welcome to Drevi Wholesale Portal

🔗 wholesale.drevifashion.com
✉️ meera@sharma-boutique.com
🔑 Tulip-Lotus-7382

Save this message. Tap the link anytime to
browse our full catalog with wholesale pricing.

— Rakesh
+91 88280 43555
```

Rakesh picks WhatsApp from the share sheet, picks the buyer (now in his contacts thanks to vCard import — Section 6.7), sends. The shared event is logged: `credential_shared`, notes: "WhatsApp".

### 6.6 Buyer login

- `/login` — single screen with email + password fields, "Forgot Password" link
- Standard Supabase email/password authentication
- On success: `auth_audit_log` event `login_success`, redirect to `/catalog`
- On failure: `auth_audit_log` event `login_failed` (with the attempted email), generic error to user
- Session persists 30 days
- Middleware on every page load checks `buyers.status` — non-active = redirect to `/login` with a status-appropriate message:
  - `pending` → "Your account is awaiting approval. Rakesh will be in touch shortly."
  - `suspended` → "Your account is inactive. Please contact Rakesh: +91 88280 43555."
  - `rejected` → generic "Invalid credentials" (no information leak)

### 6.7 Forgot password

Two paths, both work:

1. **Buyer self-serve**: standard Supabase password reset email flow. Buyer enters email on `/forgot-password`, clicks the link in their email, sets a new password. The new password is also encrypted and stored in `encrypted_password` (so Rakesh's visibility stays in sync).
2. **Buyer asks Rakesh on WhatsApp**: Rakesh opens the buyer's detail page, taps "Share via WhatsApp" — the existing password is shared (no regeneration). This is the friction-free path most buyers will use.

The `encrypted_password` is what makes path 2 trivially fast.

### 6.8 Buyer self-managed password change (optional, v3)

Not in v2.2. The current model assumes Rakesh is the credential manager; buyers don't need to change passwords because forgetting them is a 30-second WhatsApp message away. If buyers later request the ability to change passwords themselves, add a `/account/password` screen and update the encryption on change. Skip for launch.

### 6.9 Staff login

- Same Supabase Auth, but the email maps to a row in `staff_users` instead of `buyers`
- Middleware reads role from `staff_users.role` and gates `/admin` routes accordingly
- `/login` is shared between buyers and staff — the redirect after success depends on which table the email exists in (buyer → `/catalog`, staff → `/admin`)
- Staff passwords are NOT stored in `encrypted_password` (they're privileged accounts, not B2B relationships — standard hashed-only)

---

## 7. Screen-by-Screen Specification

### 7.1 Design language (locked in catalog prototype, v2.2)

Royal Noir applied to a B2B portal. Reference: the catalog prototype artifact built alongside this spec.

- **Palette**: Rich Black `#1A1A1A`, Soft Black `#2D2926`, Antique Gold `#C4A35A`, Warm Ivory `#FAF6F0`, Deep Ivory `#F2EBDC`, Champagne `#E8D5B7`
- **Typography**: Playfair Display (product titles, prices, brand wordmark) · Montserrat (UI body, pills, buttons, labels, all caps + letter-spacing for utility text) · Cormorant Garamond reserved for brand moments only
- **Pill vocabulary** (the four stock states defined in Section 4.2): consistent shape, distinct colors. Implemented once in a `<StockPill product={p} />` component.
- **Image cards**: 4:5 aspect ratio, stylized gradient placeholders during prototype, real AI-pipeline images at launch. DREVI watermark top-left, SKU bottom-right preserved in both modes.
- **Buttons**: solid black with ivory text for primary actions, outlined for secondary. 10–11px caps with 0.18em+ letter-spacing for utility actions. No shouty CTAs.

### Part A — Buyer flow

**Screen 1: `/login`**
- Single column, centered. Logo at top in Playfair Display.
- Email field, password field, "Forgot Password" link.
- No "Create Account" link — there is no self-registration on this portal.

**Screen 2: `/catalog`**
- Top bar: hamburger · DREVI wordmark · search · cart (badge)
- Sub-bar: `WHOLESALE CATALOG · {BUSINESS_NAME}` (so buyer always knows whose account they're in)
- Filter chips: All, Sarees, Lehengas, Indo-Western, Co-ords, Drape Skirts, Jackets (horizontal scroll)
- 2-column grid on mobile, 3–4 on desktop
- Each card: image · title (Playfair) · SKU · **StockPill** (one of the four states) · price · MOQ helper if applicable · Add to Cart (disabled for Sold Out only)
- The four stock pills are the heart of this screen — they're how a buyer reads "what can I get and when" at a glance

**Screen 3: `/cart`**
- List of cart items with thumbnail, title + SKU, qty selector, line price, remove
- **Quantity rules:**
  - For `In Stock` and `Made to Order` items (restockable): no upper bound; buyer can request any positive integer
  - For `Limited Edition` items (non-restockable, stock > 0): qty capped at current stock. Helper text: "Only {stock} available — not restockable."
  - For `Sold Out` items: cannot reach the cart (Add to Cart disabled on catalog and product detail)
- **MOQ enforcement**: if `custom.min_order_qty` is set and the line qty is below it, red helper text + Submit disabled until corrected
- Subtotal, optional buyer note, Submit Order Request button
- "Made to Order" items in the cart show the lead time inline: "Made to Order · 14 days"

**Screen 4: `/order/[id]`** — Confirmation
- Order number, total, lead-time summary (max of all item lead times, e.g., "Estimated availability: 14 days"), PDF delivery status
- Same as v2.1 with the lead-time addition

**Screen 5: `/account/orders`** — Order history
- Table: date, order #, total, status. Click into any order for full detail and PDF re-download.

### Part B — Exhibition flow (unchanged from v2 except stock display follows the four-state model)

E1–E6 are documented in v2.0 spec. The substantive change in v2.2:
- The exhibition catalog (E4) uses the same four-state StockPill system as the buyer catalog. The `display_stock_quantity` toggle is removed; restockable/restock_days metafields drive the display universally.
- The wholesale-price toggle (Eye / EyeOff in the header) is still present for hiding prices when handing the tablet to an unvetted walk-up buyer. This is independent of stock display.

Refer to v2.0 spec Section 7 Part B for full E1–E6 detail.

### Part C — Admin (Rakesh & Ansh)

#### 7.2 Admin shell

Left sidebar (collapsible on mobile):
- **Buyers** (active)
- **Orders**
- **Exhibitions**
- **Audit Log** (new in v2.2)
- **Staff** (super_admin only)

Top bar: search · staff name + role badge · logout

#### 7.3 Buyers tab (new in v2.2)

**Primary view: buyer list table**

Columns:
- Business name (sortable, primary)
- Owner name
- Phone (with WhatsApp icon next to it — click opens wa.me)
- City
- Status pill (Pending / Active / Suspended / Rejected — with the same visual treatment as stock pills for consistency)
- Source pill (small, monochrome: Inquiry / Exhibition / Manual)
- Orders count
- Last order date
- Created date

Top controls:
- Search box (matches business name, owner name, phone, email)
- Status filter (multi-select)
- Source filter
- Sort dropdown
- "+ Add Buyer" button (top-right, Antique Gold) → opens Case B form

Row click → opens Buyer Detail page.

Pending buyers (from inquiries or exhibitions) show a small badge at the top of the table: "3 pending buyers — review" linking to the filtered view.

#### 7.4 Buyer Detail page

```
─────────────────────────────────────────────
 SHARMA BOUTIQUE                  ● Active ▼
 Meera Sharma · +91 98XXXXXXXX · Pune
 meera@sharma-boutique.com · GSTIN 27ABCDE…
 
 Source: Inquiry · Approved 18 Feb 2026 by Rakesh

 [ Send Login Link via WhatsApp ]  [ Save to Contacts ]  [ ⋯ ]
─────────────────────────────────────────────

 ▸ CREDENTIALS
   Email:    meera@sharma-boutique.com
   Password: ●●●●●●●●●●●●●  👁  (tap to reveal)

   [ Copy ]  [ Share via WhatsApp ]  [ Regenerate ]  [ Change ]

 ▸ ORDER HISTORY  (8 orders · ₹1,82,400 total)
   DW-20260512-014 · 12 May 2026 · ₹17,300 · ✓ Fulfilled
   DW-20260418-007 · 18 Apr 2026 · ₹24,100 · ✓ Fulfilled
   ...

 ▸ NOTES
   "Bridal Asia regular. Prefers WhatsApp for restocks.
    Picky on chikankari fineness — send detail shots."

 ▸ ACTIVITY
   • Login: 12 May 2026, 11:42 AM
   • Credential shared via WhatsApp: 4 May 2026 by Rakesh
   • Login: 4 May 2026, 9:18 AM
   • Account created: 18 Feb 2026 by Rakesh
─────────────────────────────────────────────
```

**Top-of-page actions:**
- **Status dropdown**: change status (Active / Suspended / Rejected). Confirms before applying. Suspend retains credentials; Reject is destructive (with confirmation).
- **Send Login Link via WhatsApp**: shorthand — opens share sheet with the current credentials. Equivalent to expanding the Credentials section and tapping Share.
- **Save to Contacts**: downloads a vCard (Section 7.6).
- **⋯**: secondary menu — Edit Details, Add Note, View Full Audit Trail, Export Order History.

**Credentials section:**
- Email is displayed plain
- Password is masked by default; tapping the eye icon decrypts via admin server route and reveals; logs `credential_viewed`
- **Copy** — copies `email\npassword` to clipboard; logs `credential_shared` notes:"Copy"
- **Share via WhatsApp** — opens OS share sheet with formatted message (Section 6.5); logs `credential_shared` notes:"WhatsApp"
- **Regenerate** — confirmation modal: "Generate a new password and invalidate the current one?" → on confirm, generates new memorable password, updates both the hash and encrypted copy, logs `credential_regenerated`, surfaces the new value and prompts to share
- **Change** — opens a small inline form: new password text field with show/hide; logs `credential_changed`

#### 7.5 Add Buyer form (Case B)

Modal or short-form screen accessible from "+ Add Buyer" on the Buyers tab.

```
─────────────────────────────────────────────
  ADD BUYER

  Business name *  [                         ]
  Owner name    *  [                         ]
  Email         *  [                         ]
  Phone         *  [ +91                     ]
  City          *  [                         ]
  GSTIN            [                         ]  
  Notes            [                         ]

  [ Cancel ]            [ Save & Set Credentials ]
─────────────────────────────────────────────
```

On Save → buyer row created with `status: pending`, `source: manual_admin`, then the credential-setting modal (Section 6.4) opens immediately. Two clicks, two screens, one buyer onboarded with login access — the in-person speed Rakesh needs.

#### 7.6 Save to Contacts (vCard)

The "Save to Contacts" button (on buyer detail page) downloads a `.vcf` file the browser hands to the OS:

```
BEGIN:VCARD
VERSION:3.0
FN:Meera Sharma (Sharma Boutique)
ORG:Sharma Boutique
TITLE:Owner
TEL;TYPE=CELL:+919812345678
EMAIL:meera@sharma-boutique.com
ADR;TYPE=WORK:;;Pune;;;India
NOTE:Drevi Wholesale · Active · Onboarded Feb 2026
END:VCARD
```

The naming pattern `Owner Name (Business Name)` ensures Rakesh can search his contacts by either personal or business name and find the buyer instantly — which is what makes the WhatsApp share flow work later (his share sheet shows the buyer as a top recent contact instead of a phone number).

**Reverse direction (small detail, worth doing):** the WhatsApp welcome message includes a hint at the end — "Save +91 88280 43555 as 'Drevi · Rakesh'" — so the buyer's side of the address book is also synced. No vCard download for the buyer; a single-line instruction keeps it human and lightweight.

#### 7.7 Orders tab — unchanged from v2.

#### 7.8 Exhibitions tab — unchanged from v2.

#### 7.9 Audit Log tab (new in v2.2)

Read-only view of `auth_audit_log` with filters by event_type, staff_user, buyer, date range. Most operational; rarely visited unless investigating a specific incident. Important for the same reason any audit log exists: it's the receipt that proves Rakesh isn't reading buyer passwords casually, and that no one else is either.

Table: Time · Event · Buyer (if any) · Staff (if any) · Notes · IP.

#### 7.10 Staff tab (super_admin only) — unchanged from v2.

---

## 8. Offline Strategy

Unchanged from v2.0 except: stock display caveats no longer reference `display_stock_quantity` (since the setting is removed). The four-state pill system carries the same timestamp caveat language when offline:

- `In Stock (as of 10:42 AM)` or `Limited Edition · 3 left (as of 10:42 AM)` when offline
- `Made to Order · 14d` and `Sold Out` don't change with stock-time, so they show without caveat

Refer to v2.0 Section 8 for full offline / PWA / IndexedDB / sync detail.

---

## 9. PDF + WhatsApp Order Confirmation

Unchanged from v2.0. The PDF template displays each line item with its stock state captured at submission time ("Made to Order · 14 days" stays in the PDF even if stock changes later), so the buyer's PDF accurately reflects what they were told when they submitted.

Refer to v2.0 Section 9 for full detail.

---

## 10. Notifications

### To Rakesh

WhatsApp via Interakt (same template structure as v2.0) — three event types:

1. **New inquiry from `/wholesale` form** → triggers `wholesale_inquiry_alert` template
2. **New exhibition capture pending review** → triggers `wholesale_pending_review` template (batched at end of session)
3. **New order submitted** → triggers `wholesale_order_alert` template

### To buyer

1. **Welcome email** (on credential creation, if checked in modal) → `wholesale_welcome_email` template via Interakt's email channel or Supabase SMTP
2. **WhatsApp credential share** (manual, via OS share sheet) → not a template, just text Rakesh sends from his own WhatsApp
3. **Order confirmation PDF** (on every order submission) → `wholesale_order_confirmation` template with PDF attachment (Section 9)

Interakt templates required for v2.2 (submit for Meta approval on day 1):
- `wholesale_inquiry_alert` (to Rakesh)
- `wholesale_pending_review` (to Rakesh)
- `wholesale_order_alert` (to Rakesh)
- `wholesale_welcome_email` (to buyer, email channel)
- `wholesale_order_confirmation` (to buyer, with PDF media header)

---

## 11. Non-Functional Requirements

Unchanged from v2.1. Reference: SEO/discoverability (noindex, robots disallow, never linked), performance (catalog < 3s on 4G, instant from cache during exhibition), device targeting (mobile-first buyer, tablet-first exhibition), branding (Royal Noir tokens, locked design language), reliability (service worker, IndexedDB versioning, PDF testing, Interakt failure handling).

---

## 12. Deployment Plan

### Domain
- `wholesale.drevifashion.com` (subdomain) — Vercel handles natively

### Launch sequence

1. Create Supabase project; set up `buyers`, `orders`, `staff_users`, `exhibition_sessions`, `auth_audit_log` tables; configure auth; seed three staff users. Generate `PORTAL_PASSWORD_MASTER_KEY` and store in Vercel + Ansh's password manager.
2. Add `Restockable` and `Restock Days` columns to the Product Master Sheet. Update the AI pipeline to read both columns, validate (Restockable required, Restock Days required if Y), and write to Shopify metafields `custom.restockable` and `custom.restock_days`.
3. Configure Shopify metafields (existing `wholesale_price`, `wholesale_visible`, `min_order_qty` + new `restockable`, `restock_days`); generate Storefront API token.
4. Submit Interakt templates for Meta approval (5 templates listed in Section 10) — do this on day 1, 24-hour wait.
5. Build remote buyer flow (Login, Catalog with four-state pills, Cart with MOQ + restockable rules, Submit, Confirmation).
6. Build admin Buyers tab + Buyer Detail page + Credential-Setting Modal + vCard download.
7. Wire AES-256-GCM encrypt/decrypt server routes for `encrypted_password` column. Test round-trip.
8. Wire `auth_audit_log` writes on every credential event.
9. Build exhibition flow (E1 → E6) — reuse the four-state pill, add price toggle, audit-log events for exhibition orders.
10. Wire PWA: next-pwa setup, service worker, IndexedDB schema, prefetch logic.
11. Wire `@react-pdf/renderer` for the order PDF.
12. Wire Interakt sends (buyer PDF + Rakesh alerts + welcome email).
13. Deploy to Vercel; configure wholesale.drevifashion.com.
14. Beta test:
    - Rakesh onboards 3–5 existing wholesale buyers via Case B (manual add) — share credentials via WhatsApp, verify they log in
    - Process one mock inquiry through Case A (approve → credentials → activate)
    - Grishma runs a mock exhibition session, captures a "pending" buyer, Rakesh later approves and credentials are sent
15. Open to all approved buyers and use at next real exhibition.

### Beta criteria before launch
- 10 successful buyer logins across at least 3 different physical devices
- 5 credential shares via WhatsApp (verify the share sheet pre-fills correctly on iOS and Android)
- 1 successful password regeneration (old password invalidated, new one works)
- 1 successful password change to a custom value
- Audit log shows every event with correct staff attribution
- vCard download works on iPhone Safari and Android Chrome; contact appears correctly in WhatsApp
- 5 offline-mode exhibition submissions sync cleanly when reconnected

---

## 13. What This Spec Deliberately Excludes (v3+)

- **Buyer-initiated password change** (`/account/password`) — for v3 if buyers ask
- **Buyer-initiated profile updates** (city, GSTIN, business name) — for v3 if buyers ask
- **Reorder from order history** (one-click reorder)
- **New arrivals flag** (since buyer's last login)
- **Back-in-stock alerts** (WhatsApp ping when a Limited Edition piece restocks, IF a restockable variant exists)
- **Bulk order discounts** auto-applied at thresholds
- **Analytics dashboard** for Rakesh (top buyers, top products, conversion by exhibition, lead-time accuracy vs promised)
- **Multi-language support** (Hindi UI for buyers who prefer it)
- **Inline messaging** between buyer and Rakesh on a specific order
- **WhatsApp OTP as alternate login** (only revisit if email/password proves insufficient in practice)
- **Refund / return flow** within the portal
- **Cloudflare Access in front of Vercel** (additional access-control layer for paranoia)

---

## 14. Build Approach

**Recommended method:** Claude Code with this spec as the build prompt, the catalog prototype artifact as the visual reference for design tokens.

**Estimated build time:** 22–30 hours total (up from v2.1's 18–25). The credential modal, encrypted-at-rest password column, audit logging, four-state stock pill component, and vCard generation are the v2.2 additions. Realistic plan: two long weekends + a few evening sessions.

**Suggested order in Claude Code:**

1. Scaffold Next.js + Supabase + Tailwind + Royal Noir tokens from the catalog prototype
2. Build buyer login (`/login`) + middleware (status check, role redirect)
3. Build buyer catalog with the four-state StockPill component (verify against prototype)
4. Build buyer cart with MOQ + qty rules (capped for Limited Edition, unbounded for restockable)
5. Build admin Buyers tab + Buyer Detail page
6. Wire AES-256-GCM encryption + audit logging (this is the trickiest piece — get it right before building UI on top)
7. Build credential-setting modal + WhatsApp share + vCard download
8. Wire admin add buyer form (Case B) and approve/reject (Case A)
9. Build exhibition flow E1 → E6 (reuse all the buyer components)
10. Wire @react-pdf/renderer; render and test the order PDF with all four stock states represented
11. Wire Interakt API for the five templates
12. Layer in PWA: next-pwa config, service worker, IndexedDB schema, prefetch logic, offline queue, sync handler
13. Stress-test: airplane-mode the tablet, complete a full exhibition session, reconnect, verify clean sync; verify credential regeneration logs correctly; verify vCard imports cleanly on a test phone
14. Deploy to Vercel with wholesale.drevifashion.com subdomain
15. Beta criteria (Section 12)

**Hand-off to Rakesh:** A 20-minute walkthrough video covering: log in, browse Buyers tab, approve a pending inquiry, set credentials, share via WhatsApp, regenerate when a buyer asks, save to contacts.

**Hand-off to Grishma:** The same 15-minute exhibition walkthrough from v2.0, plus a note that her job ends at "Save as Pending" — Rakesh approves and credentials follow.

---

*Drevi Fashion | Dream Forward. Root Deep.*
*Wholesale Portal Spec v2.2 — May 2026*
*Supersedes v2.1, v2.0 (May 2026), v1.0 (April 2026)*
