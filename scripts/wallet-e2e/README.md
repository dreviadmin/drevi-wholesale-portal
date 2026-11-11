# Wallet end-to-end check

`wallet_e2e.py` runs the Drevi Wallet the way the theme does, against a
running portal, the live Shopify store and one Supabase project, and checks
what Shopify and the database say at each step. It is the suite that passed
22/22 on dev and prod on 3 Oct 2026, rebuilt from the session transcripts
in November 2026 (the October copy lived in a temporary folder and is gone),
plus four checks added then.

The repo is public. The script holds no secrets and no customer data: it
reads the keys from the portal's env files and never prints them.

## What it touches

There is one Shopify store for dev and prod, so **both targets write to the
live store**:

- Two throwaway customers, `wallet-test+<run>a@drevifashion.com` and
  `…b@…`, tagged `wallet-test`. Each gets a random Indian mobile number that
  is first checked against every Shopify customer and every wallet in the
  target database, so it never takes a number someone already has. Both
  join with WhatsApp consent **off**, so neither is tagged `wa-opt-in`.
- Real automatic discounts titled `Drevi Wallet · WLT-…`, limited to those
  customers. They count toward Shopify's 25 active automatic discounts while
  they exist (a few seconds to a minute).
- Two storefront carts on drevifashion.com (cookie jars, no orders placed).
- Wallet rows (`wallet_accounts`, `wallet_ledger`, `wallet_redemptions`) in
  the target's Supabase project.

At the end, even after a failure, it deletes the discounts, the wallet rows
and the customers. Before deleting a customer it clears the phone and
removes every tag, so any app that syncs customers from Shopify last sees the
record without a phone or `wa-opt-in`. The AiSensy WhatsApp app is installed
on the store and may keep contacts it synced earlier: the October 2026 runs
joined with consent on, so numbers from those runs may still be in AiSensy's
contact list (checking that needs AiSensy access).

The last line reports what is left: active `Drevi Wallet` automatic
discounts (and how many sit on test customers) and `wallet-test` customers.
A real shopper's open reservation also shows up in the first number, so
only "on test customers" must be 0.

## Targets

| `--target` | Portal | Supabase | Env files, from the repo root, first one wins |
|---|---|---|---|
| `dev` | `http://localhost:3000` (`npm run dev`) | dev, `qvnvxcdyvcsgxulbcmzm` | `.env.development.local` |
| `prod` | `https://drevi-wholesale-portal-swart.vercel.app` | prod, `cofarxgywnrdjbizxbxw` | `.env.local`, then `.env.development.local` |

The script refuses to run when the Supabase URL it read is not the target's
project. `--env <file>` (repeatable) replaces the default files, and
`--base <url>` points it at another portal. It needs
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`WALLET_STOREFRONT_SECRET` (signs the storefront token, as the theme does),
`SHOPIFY_STORE_DOMAIN`, and `WALLET_SHOPIFY_CLIENT_ID` /
`WALLET_SHOPIFY_CLIENT_SECRET` (the Drevi Admin Automation app, which the
wallet itself uses). On Ansh's Mac only the dev env file has the wallet
names, which is why prod falls back to it for those.

For `dev`, start the portal first from the same checkout, so it uses the
dev database (Next reads `.env.development.local` before `.env.local` in
dev mode). The local server needs `WALLET_STOREFRONT_SECRET`,
`WALLET_SHOPIFY_CLIENT_*` and `SHOPIFY_STOREFRONT_TOKEN`; the dev Vercel
deploy has none of them, so test locally, not there.

## Run it

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
npm run dev                     # in another terminal; wait for "Ready"
DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 -E scripts/wallet-e2e/wallet_e2e.py --target dev
```

Prod, after a deploy (from the checkout that has the prod `.env.local`):

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal-main
DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 -E scripts/wallet-e2e/wallet_e2e.py --target prod \
  --env .env.local --env /Users/anshsarawagi/Documents/drevi/wholesale-portal/.env.development.local
```

It exits 0 only when every check passed. If the last line reports leftovers
on test customers, sweep them:

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 -E scripts/wallet-e2e/wallet_e2e.py --target dev --cleanup
```

`--cleanup` deletes only customers with a `wallet-test+…@drevifashion.com`
email and no orders, wallet discounts whose customers are all such test
customers, and the target database's wallet rows for them (plus rows named
`Wallet E2E A/B`, or the October names `Test Wallet` / `Test Second`, whose
Shopify customer no longer exists). A wallet discount whose customer list is
empty is reported, not deleted: it may be a real shopper's.

`DEVELOPER_DIR` is needed only on Ansh's Mac (Xcode licence gate).

## What it checks (26)

Joining:

1. A new customer's `/join` opens a wallet with ₹1,000.
2. The customer has no `wa-opt-in` tag, and the wallet no WhatsApp consent.
3. The phone pre-check rejects a number already in use (the customer's own,
   just planted).
4. `/join` again, with another number, changes nothing: same Shopify phone,
   same wallet phone, same tags, `created: false`.
5. A storefront token older than 24 hours is refused (401).

Check 4 needs a portal that has the November 2026 `/join` change (a member's
`/join` writes nothing); an older deploy fails it. Check 5 uses
`TOKEN_MAX_AGE_H` at the top of the script, which must match
`TOKEN_MAX_AGE_S` in `src/lib/wallet-token.ts`.

The reservation:

6. Use the wallet → ok.
7. The reservation is open and linked to an automatic discount.
8. The discount is ACTIVE and titled `Drevi Wallet · <code>`.
9. It is limited to this one customer.
10. ₹1,000 off the order, ₹5,000 minimum, not per item.
11. It ends two hours after it starts.
12. It does not combine with other order discounts.

The bag (the 3 Oct failure: Shopify shows a customer-limited discount only on
a cart that knows the buyer):

13. Use with a real cart token → `identified`.
14. That cart shows `Drevi Wallet · <code>` −₹1,000 after one update.
15. `/me` reports the open reservation and ₹0 available.
16. A second device's cart does not show it by itself.
17. `/api/wallet/cart` identifies the second cart.
18. …and then it shows the line too.
19. Remove clears it from both carts on their next update.
20. `/api/wallet/cart` with nothing open says so.
21. A label instead of a cart token: still ok, just not identified.
22. Using it again replaces the reservation (old discount deleted, one open).

Two shoppers (the 3 Oct "Title must be unique" failure):

23. Two customers can hold wallet discounts at once.
24. Both exist in Shopify, ACTIVE, with distinct titles.
25. Remove deletes the discount.
26. A ₹4,999 bag is refused (422).

Not covered: placing an order (the webhooks), which needs a real checkout.
Use `scripts/wallet-replay.mjs` to re-run a webhook for an existing order.
