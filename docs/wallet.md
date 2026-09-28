# Drevi Wallet

A store-credit balance for retail customers, with a statement. Built 26 Sep
2026 (Ansh's decisions: ₹1,000 welcome for everyone, 10% of the amount
actually paid on every fulfilled-and-paid order, rolling 12-month expiry,
₹5,000 minimum order to redeem). Sign-in moved from a WhatsApp code to
Shopify's own email sign-in on 28 Sep 2026, when WhatsApp delivery was
blocked (Meta error 131037) and launch could not wait.

## Identity: Shopify sign-in plus a mandatory phone

- **Authentication is Shopify's.** The store runs new customer accounts:
  email plus a one-time code Shopify sends, no password, accounts optional,
  login not required at checkout.
- **The phone is ours to require.** A wallet opens only once the customer
  has given a mobile number, through the sign-up form (popup, bag, My
  Account). The phone is written onto the Shopify customer and keys the
  wallet row.
- **The theme vouches for who is signed in.** For a signed-in customer the
  theme renders `"<customerId>.<unixSeconds>.<hmac>"` with Liquid's
  `hmac_sha256` and the key in the shop metafield `drevi.wallet_key`. The
  portal checks it with the same key (`WALLET_STOREFRONT_SECRET`), and
  accepts it for 24 hours (`src/lib/wallet-token.ts`, with tests).
- **The phone is not verified.** Guards: ₹1,000 is usable only on orders of
  ₹5,000+; one welcome per phone and per wallet; COD King checks the phone
  on COD orders. A wallet already on another *signed-in* account is never
  handed over by typing its number (`phoneClaimDecision`). A wallet on a
  phone-only record (a past COD buyer) moves to the signed-in account and
  both records are tagged `phone-review` so they can be merged in Shopify.

## Sign-up and joining

| Who | What they do | What happens |
|---|---|---|
| Not signed in | Fill the form: name, email, mobile, WhatsApp box (ticked by default, optional) | `POST /api/wallet/signup` keeps the lead in `wallet_signups`; if the email is new to Shopify, creates the customer with email + phone + tags (`source:wallet`, `wallet-signup`, `wa-opt-in` if ticked). An existing customer is left untouched until they sign in. The theme sends them to Shopify's sign-in with `login_hint` (email pre-filled) and `return_to`. |
| Just signed in | Nothing | `GET /api/wallet/me` finds their unclaimed sign-up by the email Shopify verified and opens the wallet with ₹1,000, writing the phone, name and tags onto the customer (`drevi-wallet`). |
| Signed in, no sign-up, phone already on their Shopify record | Nothing | `me` opens the wallet from that phone. |
| Signed in, no phone anywhere | Add their mobile in the popup, the bag or My Account | `POST /api/wallet/join` opens the wallet. |

The public sign-up never changes an existing Shopify customer and answers
identically whether an email or phone is known, so it can't be used to look
people up. Budget: 10 per IP and 5 per email per ten minutes, plus a
honeypot field.

## How money moves

| Event | What happens |
|---|---|
| "Use ₹X from your wallet" ticked in the cart | A `WLT-XXXXXXXX` discount code is minted for that amount (30-min life, one use, ₹5,000 minimum baked in) and applied to the cart. **Nothing is debited yet.** One open code per wallet (unique index, 0070). |
| `orders/create` with a `WLT-` code | The amount Shopify actually allocated to the code is debited; the redemption is marked used |
| `orders/paid` + `orders/fulfilled`, both true | 10% of what was paid for the merchandise (original line total less every allocated discount, wallet included; fee-helper lines excluded) credited, whole rupees, once per order |
| `orders/cancelled` | Spend returned; earning reversed, net of anything a refund already did |
| `refunds/create` | Wallet share of refunded pieces returned; earning reversed in proportion. Filed as `shopify_refund` / `<order>#<refund>` so cancels and later refunds see it |
| 12 months with no credit | Balance lapses (lazily on next read, and nightly by cron) |

Every movement is a `wallet_ledger` row with `balance_after`, posted through
the `wallet_post_movement` RPC, which locks the account and is idempotent on
`(kind, reference)`. A retried webhook or a re-run seed is a no-op.

## Files

- `supabase/migrations/0068_wallet.sql` (tables + RPC), `0070` (one open code), `0071` (`wallet_signups`; drops the old OTP table)
- `src/lib/wallet-core.ts` (+ tests): pure rules
- `src/lib/wallet-token.ts` (+ tests): the storefront customer token
- `src/lib/wallet-identity.ts`: token from a request
- `src/lib/wallet.ts`: accounts, sign-ups, joining, ledger, redemptions, webhooks
- `src/lib/wallet-shopify.ts`: customers, discount codes, order reads, webhook HMAC (uses the **Drevi Admin Automation** app)
- `src/app/api/wallet/{signup,join,me,redeem}`: the storefront's API
- `src/app/api/wallet/webhooks/shopify`, `src/app/api/cron/wallet-expire`
- `scripts/wallet-status.mjs` (read-only), `scripts/wallet-seed.mjs`, `scripts/wallet-register-webhooks.mjs`
- Theme: `snippets/drevi-wallet-store.liquid` (renders the token), `sections/drevi-wallet.liquid` (My Account), `sections/drevi-popup.liquid` (mode `phone` = wallet sign-up), the cart block, header chip and PDP nudge

## Environment

| Var | Value |
|---|---|
| `WALLET_SHOPIFY_CLIENT_ID` / `_SECRET` | the **Drevi Admin Automation** app |
| `WALLET_STOREFRONT_SECRET` | 32+ random characters; **must equal** the shop metafield `drevi.wallet_key`. Rotating it means updating both, and signs every shopper out of the wallet (not out of Shopify) until their next page load |
| `WALLET_ALLOWED_ORIGINS` | optional; defaults to the storefront origins |

Theme setting: **Theme settings → Drevi — Integrations → Wallet API base URL**
= `https://drevi-wholesale-portal-swart.vercel.app`, no trailing slash. Blank
switches every wallet surface off.

## Test before prod

- Sign up signed out → land back signed in → wallet shows ₹1,000, customer has the phone and `drevi-wallet` tag.
- Sign in with an account that has no phone → popup or My Account asks for it once.
- One real COD order with a wallet code applied, end to end: code applies → order created → debit → paid + fulfilled → 10% credits → cancel → both reverse.
- A cart at ₹4,999 must refuse; ₹5,000 must accept.

## Known limits

- The wallet is applied in the **cart**, not at checkout: on Basic, Shopify's checkout takes no custom UI.
- Shopify evaluates the COD/Partial-COD rate conditions on the total **after** discounts, so a wallet redemption can move a ₹15,500 cart under the ₹15,000 tier.
- One wallet redemption per order.
- Phones are not verified; see the guards above.
