# Drevi Wallet

Store credit for **retail** shoppers on drevifashion.com. Each wallet has a
balance and a statement. It is not the wholesale "credit-note wallets" in
`/admin/credit-notes`. That is a separate system that uses the same word.

This page covers only the wallet. For the portal in general (checkouts, env
files, deploys, Supabase access), read [HANDOVER.md](HANDOVER.md).

Everything here was checked against the code and the live store on
4 Oct 2026. Amounts in the code, the database and the logs are in paise
(100000 = ₹1,000).

## What prod runs

"The code" in this page is the working tree of
`feature/wallet` in `/Users/anshsarawagi/Documents/drevi/wholesale-portal`.
On 4 Oct it held the webhook and money fixes listed under
[History](#history), uncommitted. They were not on `main`, and the newest
prod deploy was from 3 Oct. Until they ship, prod behaves the old way:

- A webhook whose handler fails is logged as
  `[wallet-webhook] <topic> <order gid>: <error>`, answered 200 and never
  retried. Treat every such line like a `GAVE UP` (see
  [A webhook GAVE UP](#a-webhook-gave-up)).
- There are no `GAVE UP` or `SHORTFALL` lines. A clamped debit still logs
  `debited <amount Shopify took off>`.
- An `orders/create` that runs after the order was cancelled still debits.
- A failed Remove forgets the discount id, so the nightly sweep can't delete
  that discount.
- The statement names orders by the last 4 digits of the order id.

To see what has shipped, run the `git log` command at the end of
[History](#history), and list prod deploys with
`npx --yes vercel ls --environment production` from
`/Users/anshsarawagi/Documents/drevi/wholesale-portal-main`.

## The rules

| Rule | Value | In the code |
|---|---|---|
| Welcome credit | ₹1,000 when a wallet opens. One per phone. | `WALLET_DEFAULTS.welcomePaise`, `ensureAccount` |
| Earning | 10% of what the customer paid for the merchandise, once the order is both **paid** and **fulfilled**. "Paid" is each line's price after every discount, the wallet included. Shipping (the COD fee is charged as a shipping rate), tax and fee-helper lines (product type `Service`: "Alteration & Fitting" and "Partial Payment" on 4 Oct) are left out. Refunded pieces are left out. Rounded down to whole rupees. | `earnBasePaise`, `earnAmountPaise` |
| Spending | In the bag, on orders whose subtotal is ₹5,000 or more before the wallet comes off. Whole rupees. No cap on how much of the order it covers. | `redeemablePaise` |
| Expiry | Rolling 12 months. Any credit restarts the clock. A wallet with no credit for 12 months lapses to zero. | `wallet_post_movement`, nightly cron |
| Who | One wallet per phone number (`wallet_accounts.phone` is unique). The phone is not verified. | `normalizePhone` |

A wallet also opens on its own: when someone places an order and has no
wallet, `orders/create` opens one, with the ₹1,000 welcome, for the first
usable phone on the order.

Vercel env vars can override all four numbers (see [Environment](#environment)).
The theme copy hard-codes ₹1,000, ₹5,000, 10% and 12 months in many places,
so change the copy too, or the site states the wrong numbers. On 4 Oct prod
set none of the overrides.

## Identity: Shopify sign-in plus a required phone

- **Shopify does the sign-in.** The store uses new customer accounts: email
  plus a one-time code that Shopify sends. No password. Accounts are
  optional, and checkout does not need a login.
- **We require the phone.** A signed-in shopper's wallet opens only once we
  have a mobile number: from the sign-up form, the popup (the bag's "Add your
  number" button opens it), My Account (`/pages/wallet`), or a phone already
  on their Shopify record. The number goes onto the Shopify customer and
  keys the wallet row. (Orders also open wallets; see above.)
- **The theme vouches for who is signed in.** For a signed-in customer,
  `snippets/drevi-wallet-store.liquid` renders
  `"<customerId>.<unixSeconds>.<hmac>"` with Liquid's `hmac_sha256` and the
  key in the shop metafield `drevi.wallet_key`. The portal checks it with the
  same key (`WALLET_STOREFRONT_SECRET`) and accepts it for 24 hours
  (`src/lib/wallet-token.ts`). If that env var is missing or shorter than 32
  characters, every signed-in wallet route (`me`, `join`, `redeem`, `cart`)
  answers 401. The public `signup` route and the webhook receiver do not use
  the token.
- **The phone is not verified.** The guards: the ₹1,000 works only on orders
  of ₹5,000+, and there is one welcome per phone. A wallet that already
  belongs to another account with an email is never handed over by typing
  its number; the shopper gets a 409 "already linked" message. A wallet on a
  record with no email (a past COD buyer, most of the customer list) moves
  to the signed-in account, and the records are tagged for review (see
  [A phone-review tag appears](#a-phone-review-tag-appears)).

## Sign-up and joining

| Who | What they do | What happens |
|---|---|---|
| Not signed in | Fill the form: name, email, mobile, WhatsApp box (ticked by default, optional) | `POST /api/wallet/signup` keeps the lead in `wallet_signups`. If the email is new to Shopify, it creates the customer with email, phone and tags (`source:wallet`, `wallet-signup`, `wa-opt-in` if ticked). If another customer already holds that phone, the new customer is created without it, tagged `phone-review`, with a note naming the number. An existing customer is left untouched until they sign in. The theme then sends them to Shopify's sign-in with `login_hint` (email filled in) and `return_to`. |
| Just signed in | Nothing | `GET /api/wallet/me` finds their unclaimed sign-up by the email Shopify verified, opens the wallet with ₹1,000, and writes the phone, the name (only if the record has no first name) and tags (`drevi-wallet`, `source:wallet`, and `wa-opt-in` if ticked) onto the customer. |
| Signed in, no sign-up, phone already on their Shopify record | Nothing | `me` opens the wallet from that phone. |
| Signed in, no phone anywhere | Add their mobile in the popup (also opened from the bag) or My Account | `POST /api/wallet/join` opens the wallet. |

The public sign-up never changes an existing Shopify customer. It answers the
same way whether or not an email or phone is known, so nobody can use it to
look people up. Limits: 10 per IP and 5 per email per ten minutes, plus a
hidden honeypot field (`website`).

## How money moves

| Event | What happens |
|---|---|
| Shopper taps **Use ₹X**, or **Use less** and an amount, on the bag's Drevi Wallet card | `POST /api/wallet/redeem` voids any earlier reservation, then creates a Shopify **automatic discount** for this one customer: title `Drevi Wallet · WLT-XXXXXXXX`, an amount off the order, a ₹5,000 minimum, and an end 2 hours later. It records an open row in `wallet_redemptions` and identifies the cart (see below). **Nothing is debited yet.** One open reservation per wallet (unique index, migration 0070). |
| Shopper taps **Remove** | `DELETE /api/wallet/redeem` deletes the discount and marks the reservation `void`. If Shopify refuses the delete, the row keeps the discount id, and the nightly sweep deletes the discount after its 2-hour end. |
| `orders/create`, the order carries the wallet discount | Debits what Shopify actually took off, never more than was reserved. Marks the reservation `used` and deletes the discount. If the order is already cancelled, it debits nothing. If the wallet held less than Shopify took off, the debit stops at zero and the log says `[wallet] SHORTFALL`. |
| `orders/create`, no wallet on the order | Opens a wallet for the order's phone if none exists. |
| `orders/paid` or `orders/fulfilled` | When the order is `PAID` and `FULFILLED` and not cancelled, credits the 10%. Once per order. |
| `orders/cancelled` | Returns the credit spent on the order and reverses the 10%, net of anything a refund already did. |
| `refunds/create` | Returns the wallet's share of the refunded pieces and reverses the 10% in proportion. Filed under `shopify_refund` / `<order>#<refund>`, so a later cancel or refund sees it. |
| Nightly cron, 03:30 UTC (09:00 IST) | `/api/cron/wallet-expire` lapses up to 500 expired wallets and deletes up to 200 ended wallet discounts from Shopify. Reading a wallet also lapses it if its time is up. |

Every balance change goes through the Postgres function
`wallet_post_movement` (migration 0068). It locks the account row. It returns
NULL and changes nothing for a movement it has already posted (same account,
kind, `ref_type` and `ref_id`). Otherwise it applies the amount, writes a
`wallet_ledger` row with `balance_after_paise`, and pushes `expires_at` out on
any credit. A debit that would go below zero raises an error, unless the
caller passes `p_clamp = true`; then it stops at zero. Never update
`wallet_accounts.balance_paise` directly.

The statement on My Account shows the last 50 ledger rows in plain words. It
names each order by the number the customer knows, for example "10% back on
order #1091". The webhooks write that number into each row's note. A row
without one falls back to the last 4 digits of the order id.

### Showing it on the bag (cart identity)

Shopify applies a customer-limited automatic discount only to a cart that
knows who is buying. The Online Store cart does not know, even for a
signed-in customer. So right after it creates the discount, the portal calls
the Storefront API (`cartBuyerIdentityUpdate`) with the customer's email and
the cart token the bag reads from `/cart.js`. That token has the `…?key=…`
form; Liquid's `cart.token` renders empty on the cart page.

This call uses `SHOPIFY_STOREFRONT_TOKEN`: a public Storefront access token of
the Drevi Admin Automation app, titled "Drevi Wallet — cart identity".
Without it, the bag can't show the wallet line.

The cart re-works its discounts only when it is updated, never on a plain
read. So after Use or Remove, the bag changes a hidden cart attribute
`_drevi_wallet` (it ends up on orders as a note attribute), reads the cart
back until it agrees, and then reloads.

`GET /api/wallet/me` also returns the open reservation. When the bag sees a
reservation its cart doesn't show (another device, or an identification that
didn't take), it calls `POST /api/wallet/cart` to identify this cart too. It
tries this at most once a minute per browser tab (sessionStorage key
`drevi_cw_heal`). If that fails, the bag draws the deduction itself and says
"Applied. It comes off at checkout, however you pay." It never releases a
reservation it merely can't see. It does release one when the bag drops under
₹5,000.

### Webhooks: delivery, retry and give-up

This section describes the 4 Oct code. For what prod does until it ships,
see [What prod runs](#what-prod-runs).

Shopify posts five order topics to `/api/wallet/webhooks/shopify`. For each
delivery the route:

1. Checks the HMAC signature with `WALLET_SHOPIFY_CLIENT_SECRET`. A bad
   signature answers 401.
2. Skips a delivery id (`X-Shopify-Webhook-Id`) that is already in
   `wallet_webhook_events`, and answers 200 `duplicate`.
3. Runs the handler.
4. Only after the handler succeeds, records the delivery id and logs
   `[wallet-webhook] <topic> <order gid>: <result>`.

When the handler throws, the route logs the error, records nothing, and
answers 500. Shopify then retries. Shopify's docs say it retries up to 8 times
over about 4 hours, and that it removes a subscription whose deliveries keep
failing. Running a handler twice is safe, because `wallet_post_movement`
ignores a movement it has already posted.

To protect the subscription, a delivery that still fails 3 hours after
Shopify first sent it (header `X-Shopify-Triggered-At`) is logged as
`[wallet-webhook] GAVE UP …` and answered 200. That event is lost unless
someone posts it by hand (see [A webhook GAVE UP](#a-webhook-gave-up)).

So `wallet_webhook_events` lists only deliveries that were handled to the
end. A failed delivery shows up only in the Vercel logs.

## Operations

There is no staff screen for the retail wallet. These are the tools:

| Tool | Use it to |
|---|---|
| `scripts/wallet-status.mjs` | Read wallets, statements, reservations and handled webhooks. Read-only. |
| `scripts/wallet-register-webhooks.mjs` | List or re-create the five webhook subscriptions. |
| Vercel logs (`npx --yes vercel logs`) | Find webhook results, errors, `GAVE UP` and `SHORTFALL` lines. |
| Supabase SQL editor, prod project | Look up ids. Post a ledger row by hand. |
| Shopify admin → Discounts, Customers | See or delete wallet discounts. Review tagged customers. |
| `scripts/drevi_admin.py` in the theme repo | Admin API queries. It signs in as the same Shopify app as the wallet (Drevi Admin Automation). That app can also write customers, discounts and orders, so use the helper here for read queries only. |

`scripts/wallet-seed.mjs` opens a wallet with ₹1,000 for every Shopify
customer that has a phone and no wallet yet. Without `--apply` it is a dry
run. It writes to the dev database unless you add `--prod`; `--apply --prod`
asks you to type the store name first. Never run it with `--apply` without
Ansh's go.

### Read a wallet

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal-main
node scripts/wallet-status.mjs 9876543210
```

- Pass a 10-digit Indian mobile (the script adds `91`) or the full number with
  its country code, digits only (`919876543210`). Leave the number out to see
  the 10 newest wallets. Anything else, such as a leading `+` or a space, is
  ignored, and you get the 10 newest wallets instead.
- It reads the **prod** database through `.env.local`. Add `--dev` to read the
  dev database through `.env.development.local`. Only
  `/Users/anshsarawagi/Documents/drevi/wholesale-portal` has that dev file.
- It prints the wallet count and total balance. For each wallet: phone, name,
  balance, expiry date, how it was opened, and whether a Shopify customer is
  linked; the ledger (50 rows for one phone, 5 otherwise) with notes; the
  last 5 reservations with code, amount, status and order. Then the last 10
  handled webhook deliveries (its output calls them "received") and the
  sign-up form counts.
- It does not print the account id. Get it in the Supabase SQL editor:

```sql
select id, phone, balance_paise, expires_at, shopify_customer_id
from wallet_accounts
where phone = '919876543210';
```

### Find the logs

The prod Vercel project is `drevi-wholesale-portal`.
`/Users/anshsarawagi/Documents/drevi/wholesale-portal-main` is linked to it.
`/Users/anshsarawagi/Documents/drevi/wholesale-portal` is linked to the dev
project `drevi-wholesale-dev`. The `vercel` CLI is not on PATH, so use
`npx --yes vercel`.

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal-main
npx --yes vercel logs --environment production --since 24h --query "wallet-webhook" -x
npx --yes vercel logs --environment production --since 72h --query "GAVE UP" -x
npx --yes vercel logs --environment production --since 72h --query "SHORTFALL" -x
```

| Log line | Meaning |
|---|---|
| `[wallet-webhook] <topic> <order gid>: <result>` (info) | Handled. Results look like `debited 100000`, `earned 77900`, `waiting: paid=false fulfilled=true`, `no wallet on order`, `cancelled, nothing debited`, `already debited`. |
| `[wallet-webhook] <topic> <order gid>: <error>` (error) | The handler failed. The route answered 500 and Shopify will retry. |
| `[wallet-webhook] GAVE UP <topic> <order gid> delivery <id> after <n> min — replay by hand: <error>` | Still failing after 3 hours. The event is lost until someone posts it by hand. |
| `[wallet] SHORTFALL #<order name> { requested, debited }` | Shopify took off more than the wallet held. |
| `[wallet] identify cart: …` | The Storefront call that identifies a cart failed. |
| `[wallet] delete discount: …` | A Shopify discount delete failed. The nightly sweep tries again. |
| `[wallet] delete used discount: …` | The discount of a placed order was not deleted. The sweep does not retry it; it stays live until its 2-hour end. Delete it in Shopify admin → Discounts. |
| `[wallet] /api/wallet/<route> <method>: <error>` | A wallet route threw. The shopper saw "Something went wrong on our side. Please try again in a moment." |
| `[wallet] WALLET_STOREFRONT_SECRET is missing or shorter than 32 characters` | Every signed-in wallet route (`me`, `join`, `redeem`, `cart`) answers 401. |

### The five webhook topics

| Topic (as Shopify and the script name it) | Handler in `src/lib/wallet.ts` | What it does |
|---|---|---|
| `ORDERS_CREATE` | `onOrderCreated` | Debits a wallet discount, or opens a wallet for a new buyer. |
| `ORDERS_PAID` | `onOrderPaidOrFulfilled` | Credits the 10% when the order is paid and fulfilled. |
| `ORDERS_FULFILLED` | `onOrderPaidOrFulfilled` | Same handler. Whichever topic runs once both are true does the credit; the other finds it done. |
| `ORDERS_CANCELLED` | `onOrderCancelled` | Returns spent credit, reverses the 10%. |
| `REFUNDS_CREATE` | `onRefund` | Returns the wallet share of refunded pieces, reverses the 10% in proportion. |

All five point at
`https://drevi-wholesale-portal-swart.vercel.app/api/wallet/webhooks/shopify`
and belong to the **Drevi Admin Automation** app (checked 4 Oct). Shopify
signs each delivery with the secret of the app that subscribed. So the
subscriptions must belong to the same app whose secret is in
`WALLET_SHOPIFY_CLIENT_SECRET`.

### Check and re-register the webhooks

List what is there:

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal
node scripts/wallet-register-webhooks.mjs --list
```

Re-create any that are missing:

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal
node scripts/wallet-register-webhooks.mjs --url https://drevi-wholesale-portal-swart.vercel.app/api/wallet/webhooks/shopify
```

- The script leaves an existing topic and URL alone and never deletes
  anything, so you can re-run it safely.
- It reads `.env.local`, then `.env.development.local` on top. It needs
  `WALLET_SHOPIFY_CLIENT_ID` and `WALLET_SHOPIFY_CLIENT_SECRET`. On Ansh's Mac
  (4 Oct), only `/Users/anshsarawagi/Documents/drevi/wholesale-portal/.env.development.local`
  has them, so run it from that folder. Without them, the script quietly
  uses `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (the Drevi Pipeline app)
  instead. Subscriptions made by that app fail the HMAC check, and every
  delivery answers 401.
- Re-run it when orders come in but no `[wallet-webhook]` lines appear
  (Shopify may have removed the subscriptions), or when the portal URL
  changes.

You can cross-check with the theme's Admin API helper (same app). It lists the
same five:

```bash
cd /Users/anshsarawagi/Documents/Drevi_Website/drevi-shopify-theme
DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 scripts/drevi_admin.py gql '{ webhookSubscriptions(first:50){ nodes{ topic endpoint{ ... on WebhookHttpEndpoint{ callbackUrl } } } } }'
```

`DEVELOPER_DIR` is needed only on Ansh's Mac (Xcode licence gate).

### The 25 automatic discount cap

Shopify allows 25 **active** automatic discounts per store at a time. Each
open wallet reservation holds one for up to 2 hours. Marketing automatic
discounts count toward the same 25. On 4 Oct the store had one, "10% discount
on first order"; it ended on 26 Sep, so it was expired and did not count. Dev tests use the same store, so
their discounts count too.

When the cap is reached, Shopify refuses the new discount.
`POST /api/wallet/redeem` answers 503 with reason `busy`, and the bag shows
"Lots of shoppers are using their wallet right now. Try again in a minute."

Count the active ones (none were active on 4 Oct):

```bash
cd /Users/anshsarawagi/Documents/Drevi_Website/drevi-shopify-theme
DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 scripts/drevi_admin.py gql '{ automaticDiscountNodes(first:50, query:"status:active"){ nodes{ id automaticDiscount{ __typename ... on DiscountAutomaticBasic{ title endsAt } ... on DiscountAutomaticBxgy{ title endsAt } ... on DiscountAutomaticFreeShipping{ title endsAt } ... on DiscountAutomaticApp{ title endsAt } } } } }'
```

If shoppers see the busy message:

1. Run the count above.
2. In Shopify admin → Discounts, delete leftover `Drevi Wallet · WLT-…`
   entries whose reservation is no longer `open` (match the code with the
   `wallet-status.mjs` output). Do not delete one whose reservation is still
   `open`: the bag would still say "Applied", but checkout would not take it
   off until the shopper taps Remove and then Use again.
3. Ask whoever runs marketing whether a marketing automatic discount can end.

### When something goes wrong

#### A customer says the wallet didn't apply

First ask where it went wrong: in the bag, at checkout, or on a placed order.

**In the bag**, the Drevi Wallet card says why:

| The card says | Cause | What to do |
|---|---|---|
| "Sign up and get ₹1,000…" | Not signed in | Sign in. |
| "Add your mobile number and your wallet opens…" | Signed in, no wallet yet | Add the number. |
| "Add ₹X more to use it" | Subtotal under ₹5,000 | Nothing; that is the rule. |
| "Nothing in your wallet yet" | Balance is zero | Check the statement with `wallet-status.mjs`. |
| "Lots of shoppers are using their wallet right now" | The 25 cap | See [the 25 cap](#the-25-automatic-discount-cap). |
| "Couldn't load your wallet. Refresh the page to try again." | The wallet summary call failed: the portal is down, or it rejected the page's token | Refresh. If every shopper sees it, read the Vercel logs and check that `WALLET_STOREFRONT_SECRET` matches `drevi.wallet_key`. |
| "Please sign in again." (after tapping Use) | The page's token is over 24 hours old, or was rejected | Reload the page. |
| "Couldn't reach your wallet…" | The request got no answer | Check the portal is up and read the Vercel logs. |
| "Applied. It comes off at checkout, however you pay." | Reserved, but this cart could not be identified | See [The bag keeps reloading](#the-bag-keeps-reloading-or-the-wallet-line-comes-and-goes). |

**At checkout:**

- The discount ends 2 hours after Use. After that, the shopper taps Use again
  in the bag.
- The discount carries its own ₹5,000 minimum. If the bag falls under
  ₹5,000 after Use, it no longer applies.
- It does not combine with other order discounts
  (`combinesWith.orderDiscounts` is false). A promo code that takes money off
  the whole order and the wallet can't both apply.

**On a placed order:**

1. Open the order in Shopify admin. Look for a discount line titled
   `Drevi Wallet · WLT-…`.
2. Run `wallet-status.mjs` for the customer's phone. Look for a `redeem` row
   for that order.
3. Discount on the order but no `redeem` row: the `orders/create` webhook did
   not finish. Search the logs for the order id. If the order is less than
   about 4 hours old and the log shows only plain error lines, Shopify is
   still retrying; wait. A `GAVE UP` line means follow
   [A webhook GAVE UP](#a-webhook-gave-up). (Until the 4 Oct fixes ship, a
   plain error line also means that; see [What prod runs](#what-prod-runs).)
4. No discount on the order: the wallet was not used. Nothing was debited,
   and the reservation lapses after 2 hours. Any make-good (a partial refund
   in Shopify, or a goodwill `adjust` row) is Ansh's decision.

#### The bag keeps reloading, or the wallet line comes and goes

The bag identifies the cart, retries at most once a minute per tab, and
otherwise draws the deduction from the reservation. If it still misbehaves:

1. Check that prod has `SHOPIFY_STOREFRONT_TOKEN` (this lists names only):

   ```bash
   cd /Users/anshsarawagi/Documents/drevi/wholesale-portal-main
   npx --yes vercel env ls | grep -E 'WALLET|STOREFRONT'
   ```

2. Check the Storefront token still exists on the app. Ask for titles only;
   never print the token itself:

   ```bash
   cd /Users/anshsarawagi/Documents/Drevi_Website/drevi-shopify-theme
   DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 scripts/drevi_admin.py gql '{ shop{ storefrontAccessTokens(first:10){ nodes{ title createdAt } } } }'
   ```

   You should see "Drevi Wallet — cart identity". If it is gone, create a new
   Storefront access token for the Drevi Admin Automation app, put it in
   Vercel prod as `SHOPIFY_STOREFRONT_TOKEN`, and redeploy.
3. Search the logs for `[wallet] identify cart:` to see the error.
4. Ask the shopper to tap Remove, then Use again, on one device.

#### A webhook GAVE UP

1. Find the line (see [Find the logs](#find-the-logs)). Note the topic, the
   order gid, the delivery id and the error.
2. Fix the cause the error names (Shopify throttling, a Supabase outage, a
   code bug). While the cause is there, new orders fail the same way.
3. Check the subscriptions still exist (`--list`, above). Re-register if not.
4. Post by hand what the handler would have posted, with the same references
   (table below). A later automatic run then finds it and does nothing.

| Topic that gave up | What to post |
|---|---|
| `orders/create`, order used the wallet | `redeem`, minus what the order's `Drevi Wallet · WLT-…` line took off, `p_clamp = true`, ref `shopify_order` / order gid, note `Used on #<name>`. Then mark the reservation used (SQL below) and delete the leftover discount in Shopify admin → Discounts. |
| `orders/create`, no wallet on the order | Nothing. The wallet opens when the paid-and-fulfilled credit runs, or when the customer joins. |
| `orders/paid` or `orders/fulfilled` | First check the statement: the other topic may already have credited it. If not, and the order is now Paid and Fulfilled: `earn`, plus 10% of the paid merchandise rounded down to whole rupees, ref `shopify_order` / order gid, note `10% back on #<name>`. |
| `orders/cancelled` | `reverse_redeem`, plus the credit spent on the order (net of anything returned). `reverse_earn`, minus the net 10%, `p_clamp = true`. Both ref `shopify_order` / order gid, note `#<name> cancelled`. |
| `refunds/create` | `reverse_redeem` and/or `reverse_earn`, ref `shopify_refund` / `<order gid>#<refund gid>`, note `Refund on #<name>`. Work out the amounts with `walletReturnOwedPaise` and `earnReversalPaise` in `src/lib/wallet-core.ts`, or ask for help. |

```sql
-- Post one movement. Arguments: account id, kind, amount in paise
-- (negative = debit), ref_type, ref_id, note, clamp, expiry months.
-- NULL back means it was already posted and nothing changed.
select wallet_post_movement('<account uuid>', 'earn', 77900, 'shopify_order',
  'gid://shopify/Order/<id>', '10% back on #1091', false, 12);

-- After a hand-posted orders/create debit, mark the reservation used.
select id, code, amount_paise, status
from wallet_redemptions
where account_id = '<account uuid>'
order by created_at desc
limit 5;

update wallet_redemptions
set status = 'used', shopify_order_id = 'gid://shopify/Order/<id>', used_at = now()
where id = '<redemption uuid>';
```

References the code uses. Match them exactly when you post by hand:

| kind | ref_type | ref_id |
|---|---|---|
| `welcome` | `seed` | the phone digits, such as `919876543210` |
| `redeem`, `reverse_redeem`, `earn`, `reverse_earn` (whole order) | `shopify_order` | `gid://shopify/Order/<id>` |
| `reverse_redeem`, `reverse_earn` (from a refund) | `shopify_refund` | `gid://shopify/Order/<id>#gid://shopify/Refund/<id>` |
| `expire` | `expiry` | the `expires_at` timestamp that ran out |
| `adjust` | anything unique, such as `manual` | such as a ticket id; the statement shows the note |

#### A debit SHORTFALL

The line looks like `[wallet] SHORTFALL #1091 { requested: 100000, debited: 0 }`,
and the webhook result reads `debited 0 of 100000 (SHORTFALL 100000)`.

It means Shopify took off more wallet credit than the wallet held when
`orders/create` ran, so the ledger debited less, maybe nothing. The gap is
money given away at checkout. Usual causes: the same reservation was used on
two devices before the first order's webhook ran; or the balance lapsed or
was clawed back while a reservation was open.

1. Note the order name and the amounts from the log.
2. Run `wallet-status.mjs` for the customer's phone to see their ledger rows
   and reservations, with the order each one names.
3. Do not try to take the balance below zero. The database refuses it.
4. Send the order names and amounts to Ansh. Whether to accept the loss or
   contact the customer is his decision.

#### A phone-review tag appears

The wallet adds `phone-review` in three cases:

| Where | What happened | Tags |
|---|---|---|
| Sign-up form | The phone belongs to another Shopify customer. The new customer was created without the phone, with a note naming the number. | `phone-review` on the new customer |
| Signing in or adding the number | The wallet for that phone sat on a record with no email, or on no record. It moved to the signed-in customer. | `phone-review` on the signed-in customer. If there was an old record: `wallet-relinked` and `phone-review` on it. |
| Signing in or adding the number | Shopify would not put the phone on the customer: another customer holds it, or the update failed for another reason. | `phone-review` on the signed-in customer |

What to do:

1. In Shopify admin → Customers, filter by tag `phone-review` (and
   `wallet-relinked`). Read the customer notes.
2. Run `wallet-status.mjs` for the phone. Check "customer linked".
3. Confirm with the customer on WhatsApp (+91 88280 43555) that the number is
   theirs.
4. If it is the same person on two records, merge the records in Shopify
   admin. Afterwards check that `wallet_accounts.shopify_customer_id` is the
   customer that remains. Remove the `phone-review` tag.
5. If someone typed another person's number, point the wallet back at the
   right customer, and tell Ansh, because the wrong person may have spent
   the credit:

```sql
update wallet_accounts
set shopify_customer_id = 'gid://shopify/Customer/<id>', updated_at = now()
where id = '<account uuid>';
```

#### Other cases

- **"This number is already linked to another Drevi account" (409).** The
  phone's wallet belongs to another account with an email. Verify the person
  on WhatsApp, then re-point `wallet_accounts.shopify_customer_id` with the
  SQL above.
- **Goodwill or a correction.** Post an `adjust` row with a unique
  `ref_type` / `ref_id` and a note. The statement shows the note.
- **Turn the wallet off.** In the theme editor of the live theme (it is the
  one named "Drevi Staging", id 157282959601, despite its name), blank
  Theme settings → Drevi — Integrations → **Wallet API base URL**.
  `config/settings_data.json` is in `.shopifyignore`, so a theme push never
  changes this setting. Discounts already created still apply until their
  2-hour end.
- **Rotate the token key.** Set `WALLET_STOREFRONT_SECRET` in Vercel prod and
  the shop metafield `drevi.wallet_key` to the same new value, then redeploy.
  Shoppers' wallet calls answer 401 until their next page load.

## Files

Portal (paths from the repo root):

| File | What it holds |
|---|---|
| `supabase/migrations/0068_wallet.sql` | Tables and the `wallet_post_movement` function. Its header is out of date; see [below](#out-of-date-comments-in-the-code). |
| `supabase/migrations/0070_wallet_one_open_code.sql` | Unique index: one open reservation per wallet. |
| `supabase/migrations/0071_wallet_signups.sql` | `wallet_signups`; drops the old `wallet_otps` table. |
| `src/lib/wallet-core.ts` (+ test) | Pure rules: phones, emails, earning, redeemable amount, refund maths, phone-claim decision, statement labels, discount title. |
| `src/lib/wallet-token.ts` (+ test) | The storefront customer token. |
| `src/lib/wallet-identity.ts` | Token from a request. |
| `src/lib/wallet-http.ts` (+ test) | CORS allow-list and `guarded()`, so an error still answers with CORS headers. |
| `src/lib/wallet.ts` | Accounts, sign-ups, joining, ledger, reservations, webhook handlers. |
| `src/lib/wallet-shopify.ts` | Shopify calls as the Drevi Admin Automation app: customers, automatic discounts (create and delete), Storefront cart identity (`identifyCart`), order reads, webhook HMAC. |
| `src/app/api/wallet/{signup,join,me,redeem,cart}` | The storefront's API. |
| `src/app/api/wallet/webhooks/shopify/route.ts` | The webhook receiver. |
| `src/app/api/cron/wallet-expire/route.ts` | Nightly lapse and discount sweep. Schedule in `vercel.json`. |
| `src/lib/backup.ts` | The hourly off-site backup (GitHub Actions, `.github/workflows/backup.yml`) includes `wallet_accounts`, `wallet_ledger`, `wallet_signups`, `wallet_redemptions`, `wallet_webhook_events`. |
| `scripts/wallet-status.mjs`, `scripts/wallet-register-webhooks.mjs`, `scripts/wallet-seed.mjs` | See [Operations](#operations). |

Theme (`/Users/anshsarawagi/Documents/Drevi_Website/drevi-shopify-theme`):

| File | What it holds |
|---|---|
| `snippets/drevi-wallet-store.liquid` | Renders the token, exposes `window.DreviWallet`, paints the header chip and the product page nudge. |
| `sections/drevi-wallet.liquid` | My Account (`/pages/wallet`): sign-up form, add-your-number, balance, statement, orders. |
| `sections/drevi-popup.liquid` | Mode `phone` is the wallet sign-up popup. |
| `templates/cart.liquid` | The bag's Drevi Wallet card and its script. |
| `config/settings_schema.json` | The **Wallet API base URL** setting. |

## Environment

Names only. Never copy the values into a doc or a chat.

| Name | What it is |
|---|---|
| `WALLET_SHOPIFY_CLIENT_ID`, `WALLET_SHOPIFY_CLIENT_SECRET` | The Drevi Admin Automation app. The secret also checks webhook signatures. If they are missing, the code quietly uses `SHOPIFY_CLIENT_ID` / `SECRET` (the Drevi Pipeline app), which lacks the scopes: calls fail with ACCESS_DENIED and the bag shows an error. |
| `WALLET_STOREFRONT_SECRET` | 32+ random characters. Must equal the shop metafield `drevi.wallet_key`. |
| `SHOPIFY_STOREFRONT_TOKEN` | Public Storefront token "Drevi Wallet — cart identity" of the same app. Needed to show the wallet line on the bag. |
| `WALLET_ALLOWED_ORIGINS` | Optional comma list. Default: `https://drevifashion.com`, `https://www.drevifashion.com`, `https://uqc34b-5y.myshopify.com`. |
| `WALLET_WELCOME_PAISE`, `WALLET_EARN_PERCENT`, `WALLET_MIN_ORDER_PAISE`, `WALLET_EXPIRY_MONTHS` | Optional overrides of 100000, 10, 500000 and 12. Not set on prod. |
| `SHOPIFY_STORE_DOMAIN`, `CRON_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Shared with the rest of the portal. |

On 4 Oct the prod Vercel project `drevi-wholesale-portal` had
`WALLET_SHOPIFY_CLIENT_ID`, `WALLET_SHOPIFY_CLIENT_SECRET`,
`WALLET_STOREFRONT_SECRET` and `SHOPIFY_STOREFRONT_TOKEN`, and none of the
optional ones. The dev project `drevi-wholesale-dev` had none of the wallet
names, so the signed-in wallet routes on the dev deploy answer 401 by design.

Shopify side:

| Thing | Value |
|---|---|
| App | Drevi Admin Automation: customers, discounts, orders, webhooks, the Storefront token |
| Admin API version | `2026-01` (in `wallet-shopify.ts` and the register script) |
| Shop metafield | `drevi.wallet_key`, same value as `WALLET_STOREFRONT_SECRET` |
| Webhooks | The five topics above, to the prod URL |
| Theme setting | Theme settings → Drevi — Integrations → **Wallet API base URL** = `https://drevi-wholesale-portal-swart.vercel.app` (live value on 4 Oct), no trailing slash. Blank switches every wallet surface off. |

Customer tags the wallet writes:

| Tag | Set when |
|---|---|
| `drevi-wallet` | The customer has a wallet. The theme reads it, for example to stop offering the sign-up popup. |
| `source:wallet` | The customer signed up or joined through the wallet. |
| `wallet-signup` | The sign-up form created the customer. |
| `wa-opt-in` | The WhatsApp box was ticked. Removed if they untick it when joining. |
| `phone-review` | See [A phone-review tag appears](#a-phone-review-tag-appears). |
| `wallet-relinked` | The wallet moved off this record to a signed-in account. |

## Test before prod

- Unit tests (on 4 Oct: 3 files, 52 tests, all pass). They cover
  `wallet-core.ts`, the token and the CORS helper. `wallet.ts` and the routes
  have no tests in the repo.

  ```bash
  cd /Users/anshsarawagi/Documents/drevi/wholesale-portal
  npx vitest run src/lib/wallet
  ```

- There is one Shopify store for dev and prod. Dev tests create real
  customers and real automatic discounts, and those count toward the 25 cap.
- The dev deploy can't run the signed-in wallet routes (401, see
  [Environment](#environment)). Test locally against the dev database, then
  on prod.
- Deploy check: a POST to a signed-in wallet route (such as `join`) without a
  token must answer 401. An
  OPTIONS request answers 204 even for a route that does not exist, so it
  proves nothing.

  ```bash
  cd /Users/anshsarawagi/Documents/drevi/wholesale-portal-main
  curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'Content-Type: application/json' -d '{}' https://drevi-wholesale-portal-swart.vercel.app/api/wallet/join
  ```

- An end-to-end script (`wallet_auto_e2e.py dev|prod`) and a bag test harness
  (`wallet-harness/`) exist only in a temporary Claude session folder,
  `/private/tmp/claude-501/-Users-anshsarawagi-Documents-drevi-pipeline-scripts/76fd220e-b2af-434d-b95d-8fc1d711c0ec/scratchpad/`.
  They are not in git. Move them into the repo before relying on them.
- By hand, at phone and laptop widths:
  - Sign up signed out → land back signed in → the wallet shows ₹1,000, and
    the customer has the phone and the `drevi-wallet` tag.
  - Sign in with an account that has no phone → the popup or My Account asks
    for it once.
  - "Use ₹1,000" in the bag: the summary shows the Drevi Wallet line within a
    second or two and the total drops. Remove puts it back.
  - One real COD order with the wallet, end to end: COD King's summary shows
    the deduction → order created → debit → paid and fulfilled → 10% credited
    → cancel → both reverse.
  - A ₹4,999 bag must refuse; ₹5,000 must accept.

## Known limits and open decisions

- **Overseas numbers.** The forms force +91 and 10 digits, and
  `normalizePhone` adds `91` to any 10-digit number. A US number that starts
  with 6–9 becomes an "Indian" number on the wallet and on the Shopify
  customer. Other overseas shoppers can't join.
- **No earning after an early partial refund.** The 10% needs Shopify's
  status to be exactly `PAID`. If one line is refunded before the order is
  paid and fulfilled, the status stays `PARTIALLY_REFUNDED` and the order
  never earns. Decide whether it should earn on what remains.
- **Orders are matched to wallets by phone.** `accountForOrder` tries the
  customer id, then the customer's, order's, shipping and billing phones, and
  takes the first wallet it finds. It links an unlinked wallet to the buyer.
  A first-time buyer who ships to a relative with a wallet earns into the
  relative's wallet and gets none of their own.
- **Relinked wallets.** Anyone signed in with an email can type the number of
  a customer who has no email and take that wallet, its balance and its
  future earnings. Only the `phone-review` / `wallet-relinked` tags record it.
  There is no staff screen to undo it; use SQL.
- **Double use before `orders/create`.** An automatic discount has no usage
  limit. Two identified carts that check out before the first order's
  webhook runs both get the discount. The second debit stops at zero and is
  logged as SHORTFALL. Preventing it needs a design change.
- **A failed Remove.** If Shopify refuses the delete, the discount stays live
  until its 2-hour end.
- **No replay tool.** A delivery that GAVE UP is only in the logs; post it by
  hand.
- **No retry on Shopify throttling.** The wallet's Shopify client retries
  only a rejected token. A throttled call makes Use fail with an error, makes
  Remove leave the discount live, and makes a webhook answer 500 (Shopify
  then retries it).
- **A lost welcome.** If the welcome credit fails right after a wallet row is
  created, a retry finds the wallet and does not post the welcome again.
- **Payment tiers move.** Shopify tests the COD and 50%-advance rate
  conditions on the total after discounts, so a wallet can move a ₹15,500
  bag under the ₹15,000 tier.
- **The wallet is applied in the bag, not at checkout,** and a wallet holds
  at most one open reservation at a time.
- **Open decisions for Ansh:** whether the uncapped share is intended (a
  ₹5,000+ balance can pay a whole ₹5,000 order); whether the 10% should be
  held until the return window closes (today it is spendable at once, and a
  later return claws it back only down to zero).
- **Not yet verified:** whether COD King applies the discount to a cart that
  was never identified (the bag tells that shopper it will); whether a guest
  checkout that types a wallet holder's email gets their open discount;
  whether signing out clears the cart's buyer email on a shared device;
  whether `drevi.wallet_key` is unreadable through the Storefront API (on
  4 Oct it had no metafield definition). An older version of this doc said
  "COD King checks the phone on COD orders". Nothing in the wallet code
  relies on that. On 4 Oct one recent order (#1081) carried a COD King note
  attribute named `_otpVerifiedPhoneNumber`, which suggests COD King checks
  the phone by one-time code on some orders; when and how was not confirmed.

## Out-of-date comments in the code

These comments describe the old design. Trust this doc and the code over
them.

| Where | What it says | What is true |
|---|---|---|
| `supabase/migrations/0068_wallet.sql`, header and `ref_type` comment | Login by WhatsApp code; a single-use discount code per cart; `ref_type` `'refund'` or `'redemption'` | Shopify email sign-in plus a phone; a per-customer automatic discount; the ref types used are `shopify_order`, `shopify_refund`, `seed`, `expiry` (plus your own for `adjust`). Leave the migration as it is. |
| `src/lib/wallet-shopify.ts`, "Discount codes" heading and the first comment above `createWalletAutomaticDiscount` | A single-use code for this cart, 30 minutes | An automatic discount per customer, ending after 2 hours |
| `src/lib/wallet.ts`, comment above `createRedemption` | Mints a code for this cart | Creates a customer-limited automatic discount and identifies the cart |
| `src/lib/wallet-core.ts`, comment above `EarnLine` | Fee helpers are "COD fee, alteration" | No COD fee product exists; the COD fee is a shipping rate. The `Service` products on 4 Oct were "Alteration & Fitting" and "Partial Payment". |
| `src/lib/wallet-core.ts`, in `normalizePhone` | "the WhatsApp send is the real verification" | There has been no WhatsApp verification since 28 Sep. Phones are not verified. |
| `src/lib/backup.ts`, wallet tables comment | Mentions the OTP table | `wallet_otps` was dropped in 0071; `wallet_signups` is backed up instead |
| Theme `config/settings_schema.json`, Wallet API base URL help text | e.g. `https://wholesale.drevifashion.com` | The live value is `https://drevi-wholesale-portal-swart.vercel.app` |

## History

- **26 Sep 2026: built.** Ansh decided: ₹1,000 welcome for everyone; 10% of
  the amount actually paid on every paid-and-fulfilled order (not on
  placement, because COD parcels get refused); rolling 12-month expiry;
  ₹5,000 minimum to redeem. The wallet is keyed on phone because most retail
  customers had a phone and no email.
- **28 Sep: WhatsApp login removed.** Sign-in moved to Shopify's own email
  sign-in, with a required phone, when WhatsApp delivery was blocked (Meta
  error 131037) and launch could not wait. `wallet_otps` was dropped (0071).
  The WhatsApp box stays ticked by default (Ansh's call).
- **2 Oct: automatic discounts.** COD King's payment window strips discount
  codes on its COD and 50% options, so the wallet moved from single-use
  `WLT-` codes to a per-customer automatic discount (commit `e8912d6` on
  main). Shopify discount Functions were ruled out because Functions in a
  custom app need Shopify Plus.
- **3 Oct: unique titles and cart identity.** Shopify requires automatic
  discount titles to be unique across the store, so one shared "Drevi Wallet"
  title failed every second shopper; titles now carry the code (`00b29f5`).
  A route that throws used to answer without CORS headers, which browsers
  show as "Failed to fetch"; every route is now wrapped in `guarded()`. "Use
  ₹1,000" looped in the bag because the Online Store cart had no buyer
  identity, so the bag never saw the line and released it; the portal now
  identifies the cart through the Storefront API (`ae2fb18`).
- **4 Oct: webhook and money fixes.** A failed webhook answers 500 so
  Shopify retries, and a delivery is recorded only after its handler
  succeeds; after 3 hours the route logs GAVE UP and answers 200.
  Shortfall debits log `[wallet] SHORTFALL`. An `orders/create` that arrives
  after a cancel debits nothing. Remove keeps the Shopify discount id when
  the delete fails, so the sweep retries it. The statement names orders by
  their #number. Unused WhatsApp-login constants were removed. When this doc
  was written, these changes were uncommitted on `feature/wallet` and not yet
  on `main`. Check before you rely on them in production:

  ```bash
  cd /Users/anshsarawagi/Documents/drevi/wholesale-portal-main
  DEVELOPER_DIR=/Library/Developer/CommandLineTools git log --oneline -5 -- src/app/api/wallet/webhooks/shopify/route.ts
  ```
