# Drevi Wallet

A store-credit balance for retail customers, keyed on **phone number**, with a
statement. Built 26 Sep 2026 (Ansh's decisions: ₹1,000 welcome for everyone,
10% of the amount actually paid on every fulfilled-and-paid order, rolling
12-month expiry, ₹5,000 minimum order to redeem).

## Why it isn't Shopify's store credit

Shopify store credit only works inside a Shopify customer account, and those
log in by **email**. 217 of the 222 retail customers have a phone and no
email, and on the Basic plan third-party phone-OTP login can't create a
Shopify account session (that needs Multipass, which is Plus-only). So the
wallet lives in the portal's Supabase, the customer logs in with a WhatsApp
code, and value is settled at checkout as a single-use discount code minted
for that cart. No gift card, no Shopify login.

## How it moves

| Event | What happens |
|---|---|
| Popup submitted (name, phone, WhatsApp box ticked) | Shopify customer found-or-created and tagged `enquiry`, `wa-opt-in`, `source:popup`; wallet opened with ₹1,000; welcome sent on WhatsApp (AiSensy also adds them to the list) |
| Phone logs in for the first time (OTP) | Wallet opened with ₹1,000 if none existed — logging in *is* joining |
| "Use ₹X from your wallet" ticked in the cart | A `WLT-XXXXXXXX` discount code is minted for that amount (30-min life, one use, ₹5,000 minimum baked in) and applied to the cart. **Nothing is debited yet.** |
| `orders/create` with a `WLT-` code | The amount Shopify actually allocated to the code is debited; the redemption is marked used |
| `orders/paid` + `orders/fulfilled` — both true | 10% of the merchandise total (after all discounts, excluding fee-helper lines) credited, whole rupees, once per order |
| `orders/cancelled` | Spend returned; earning reversed |
| `refunds/create` | Earning clawed back in proportion to what was refunded |
| 12 months with no credit | Balance lapses (lazily on next read, and nightly by cron) |

Every movement is a `wallet_ledger` row with `balance_after`, posted through
the `wallet_post_movement` RPC, which locks the account and is idempotent on
`(kind, reference)`. A retried webhook or a re-run seed is a no-op.

## Files

- `supabase/migrations/0068_wallet.sql` — tables + the RPC
- `src/lib/wallet-core.ts` (+ tests) — pure rules: phone normalising, paise, earn base, redeemable amount, expiry
- `src/lib/wallet.ts` — accounts, ledger, redemptions, what each webhook means
- `src/lib/wallet-shopify.ts` — customers, discount codes, order reads, webhook HMAC (uses the **Drevi Admin Automation** app)
- `src/lib/wallet-auth.ts` — OTP issue/verify, 30-day session tokens
- `src/lib/wallet-whatsapp.ts` — AiSensy sends (dry run unless `WALLET_WA_LIVE=true`)
- `src/app/api/wallet/{otp/send,otp/verify,me,redeem,join}` — the storefront's API
- `src/app/api/wallet/webhooks/shopify` — the receiver
- `src/app/api/cron/wallet-expire` — nightly lapse sweep
- `scripts/wallet-seed.mjs` — open wallets for existing customers (dry run by default)
- `scripts/wallet-register-webhooks.mjs` — point Shopify at the receiver
- Theme: `snippets/drevi-wallet-store.liquid`, `sections/drevi-wallet.liquid`, `templates/page.wallet.json`, plus the header chip, cart block, PDP nudge and the popup's `phone` mode

## Environment

Add to the portal's Vercel env (and `.env.development.local` for dev):

| Var | Value |
|---|---|
| `WALLET_SHOPIFY_CLIENT_ID` / `_SECRET` | the **Drevi Admin Automation** app. The portal's own app (Drevi Pipeline) has no customer/discount/order scopes |
| `WALLET_SESSION_SECRET` | any 32+ char random string (derived from the master key if absent) |
| `WALLET_ALLOWED_ORIGINS` | optional; defaults to `https://drevifashion.com,https://www.drevifashion.com,https://uqc34b-5y.myshopify.com` |
| `AISENSY_API_KEY` | already set |
| `AISENSY_CAMPAIGN_OTP` / `_WELCOME` / `_BALANCE` | the campaign names created in AiSensy (defaults `drevi_wallet_otp`, `drevi_wallet_welcome`, `drevi_wallet_balance`) |
| `WALLET_WA_LIVE` | `true` only when the templates are approved and you want real sends |
| `WALLET_DEV_RETURN_OTP` | `true` on dev only — echoes the code in the API response for testing |

Theme setting: **Theme settings → Drevi — Integrations → Wallet API base URL**
= the portal origin (e.g. `https://wholesale.drevifashion.com`), no trailing slash.

## Go-live order

1. `npm run db:migrate` (dev), then with `--prod` once tested.
2. Set the env vars above. Deploy the portal.
3. AiSensy: create the three templates from `docs/wallet-aisensy-templates.md`, wait for Meta approval, create one API campaign per template, put the campaign names in env.
4. `node scripts/wallet-register-webhooks.mjs --url https://<portal>/api/wallet/webhooks/shopify`
5. Theme: set the Wallet API base URL, push the theme, publish the `wallet` page (it is created unpublished), switch the popup on with mode **Phone number**.
6. `node scripts/wallet-seed.mjs` (dry run) → `--apply --prod` → `--send` once `WALLET_WA_LIVE=true`.
7. Turn **off** "login required at checkout" in Shopify — a Shopify login is by email and would block phone-only customers.

## Test before prod

- One real COD order with a wallet code applied, end to end: code applies at checkout → order created → debit posts → mark paid + fulfilled → 10% credits → cancel → both reverse. This is the combination the docs don't cover.
- A cart at ₹4,999 must refuse; ₹5,000 must accept.
- The header chip must survive a page reload without an API call (it reads the cached session).

## Known limits

- The wallet is applied in the **cart**, not at checkout: on Basic, Shopify's checkout takes no custom UI. The header chip and the PDP nudge keep it in view before the cart.
- Shopify evaluates the COD/Partial-COD shipping-rate conditions on the subtotal **after** discounts, so a wallet redemption can move a ₹15,500 cart under the ₹15,000 tier.
- One wallet redemption per order.
- Removing an applied wallet code from the cart uses the Cart API `discount` field with a `/discount/` redirect as fallback; confirm on the live theme.
