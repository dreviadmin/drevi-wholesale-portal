# Needed from Ansh

Living checklist of everything that is blocked on you — kept current through the
UX sprint (30 Jul 2026). Everything else in the sprint is done and verified on
dev; none of it touches production.

## WhatsApp / Interakt — what I need to turn it on (21 Sep)

Bulk credential sending is **live on prod and doing nothing**: neither Vercel
project has `INTERAKT_API_KEY`, so every send is a logged no-op and the bar
says "not configured". Three things switch it on.

**1. The API key.** Interakt → Settings → Developer Setting → the Secret Key.
It is already Base64 and goes into the `Authorization: Basic <key>` header
verbatim — do not re-encode it. Set it on both projects and redeploy each
(Vercel bakes env at build time):

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && npx vercel env add INTERAKT_API_KEY production
```

**2. Approved templates — the names and the placeholder ORDER.** `bodyValues`
are positional, so a template whose `{{1}}`/`{{2}}` are swapped sends the
password where the business name should be. Six templates, all
`languageCode: "en"`:

| Template name | Body placeholders, in order | Sent to |
|---|---|---|
| `wholesale_credentials` | business · portal link · login id · password | buyer |
| `wholesale_welcome_email` | business | buyer |
| `wholesale_order_confirmation` | order number · total (+ PDF URL as the header) | buyer |
| `wholesale_inquiry_alert` | business · city | Rakesh |
| `wholesale_pending_review` | count · event | Rakesh |
| `wholesale_order_alert` | order number · business · total · source | Rakesh |

For `wholesale_credentials`, word the third line **"Login ID: {{3}}"**, not
"Username" — a buyer credentialed on their own email address gets that address
there. Mirror the rest of the wording from the manual wa.me share
(`buildWhatsAppMessage` in `src/lib/share.ts`) so the bulk send and the
one-at-a-time share say the same thing.

**3. Two things to confirm.**

- **The sender number and opt-in.** Which WhatsApp Business number sends, and
  whether these 158 buyers count as opted in — Meta allows utility templates
  to contacts who have opted in, and a bulk send to 158 cold numbers is how a
  number gets rate-limited or flagged. Worth starting with a handful.
- **Passwords in plaintext over WhatsApp.** The message carries the actual
  password, which is what you already do by hand through wa.me, so this only
  changes the volume. Say the word if you would rather it sent a one-time
  set-your-own-password link instead — that is a bigger change and I have not
  built it.

Where it stands right now on prod: **165 buyers, 165 active, 158 messageable**
(7 have no phone). 122 came from the visiting-card import, 116 of them
messageable.

## Money / accounts

1. **FASHN credits are exhausted.** The integration works — the API accepted the
   request and returned `OutOfCredits`. Top up at fashn.ai and the fashn chip
   works with no code change. (Seedream and OpenAI were verified end-to-end on
   dev: a real 1728×2304 Seedream candidate and a real OpenAI edit both landed
   in the studio.)
2. **fal.ai + OpenAI spend now happens from the portal.** Every Generate click
   costs real money (~$0.03 Seedream, ~$0.22 OpenAI, ~2 credits FASHN). The
   estimate is shown on each button. If you want a monthly cap, say the number
   and I'll enforce it server-side.

## Decisions

3. **Prod schema drift** (from the retrofit, documented in
   [CUTOVER-LOG.md](CUTOVER-LOG.md)): leave migrations 0022–0027 in place on
   prod (recommended — additive, cutover needs them) or have the seeded
   `stock_movements` rows removed. Say which.
4. **ANSH-18 — Shopify inventory sync** still parked: until it exists, portal
   stock reads HIGH for anything sold through Shopify POS. Stock take corrects
   it (`/admin/stock-take`).
5. **ANSH-19 — Drive photo folder.** Photo capture no longer waits on this:
   photos save to the portal's own storage (`design-images` bucket) until you
   supply `DRIVE_DESIGN_FOLDER_ID` (must be a Shared-Drive folder the service
   account can write to). The moment it's set, NEW uploads go to Drive;
   existing portal-storage photos keep working forever. Consolidation of old
   per-SKU folders (the original ANSH-19 task) is still yours.

## Env / deploy (dev Vercel project)

The dev site (`drevi-wholesale-dev.vercel.app`) needs these added before the
new features work there — localhost dev has them already:

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && for k in FASHN_API_KEY FAL_KEY OPENAI_API_KEY DREVI_BRAND_MODEL_FOLDER_ID; do grep "^$k=" .env.development.local | cut -d= -f2- | tr -d '\n' | npx vercel env add $k production; done
```

then redeploy:

```bash
cd /Users/anshsarawagi/Documents/drevi/wholesale-portal && npx vercel --prod --yes
```

Notes:
- `GOOGLE_SERVICE_ACCOUNT_JSON` is already on the dev Vercel project; the
  brand-model folder read uses it.
- Vercel bakes env at build time — env changes always need one more deploy.
- FASHN generation can run ~2–4 min; Vercel Hobby caps functions at 60 s, so
  **FASHN on the deployed dev site will time out** (Seedream ~20 s and OpenAI
  ~60 s usually fit). On localhost everything runs unclamped. If FASHN-on-Vercel
  matters before the hosted runner (ANSH-04), say so and I'll split submit/poll
  into separate short calls.

## Passwords

6. Dev logins were reset during verification (prod untouched):
   `ansh` / `DevStaff!2026`, buyer `rivaaz.dev@drevifashion.com` /
   `DevBuyer!2026`. To restore the `<name>123` convention on dev, run
   `npm run db:seed-auth` — it now targets **dev** by default and its password
   list needs your sign-off first (it still holds the old `Drevi-*-2026`
   values; I was permission-blocked from editing the list).

## HSN codes — DONE (31 Jul)

10. ~~Fill HSN values~~ — **6204 is the house default** (your call: women's
    garments only). Every product, every order line and every stored bill on
    BOTH environments now carries a code. Override any product in Manage
    Catalog / the master editor / goods-in, or any order line via its HSN
    button — each entered code joins the shared dropdown. Worth a CA sanity
    check that 6204 fits everything (sarees are sometimes classified 6211).

## Productionization (2 Aug — in progress)

11. ~~wholesale_photos folder id~~ — **DONE (3 Aug)**. Folder
    `1Diepjf1hL1_4MlKAsTBti3ujMqkdLQqr` wired on local + the dev site; audit
    ran clean (136 matched, 0 ambiguous); portal-storage photos migrated to
    Drive and verified serving. ANSH-19 is closed on dev. Two folder tidy-ups
    whenever convenient: rename `DD-GWNBLL-001-PNK` → `DD-GWN-BLL-001-PNK`,
    and file/remove the loose root file + the `Heavy offwhite- P001` folder.
    At cutover, the same env var + migration run applies to prod.
12. **Cutover imports to prod** run with the same scripts you can preview any
    time: `node scripts/import-sheet-data.mjs all` (dry-run) — add
    `--write --prod` on cutover day. Already rehearsed end-to-end on dev:
    25 vendors, 162 list values, 30 historical receipts (171 lines, no stock
    movements — history only), pricing provenance on 169 SKUs, spec fields +
    120 copy drafts on designs. Occasion hints / meta title / meta description
    columns are empty in the sheet — the importer picks them up whenever
    Rakesh fills them.

## Small choices whenever you look

7. **Brand model for FASHN** defaults to the `Model-a` folder; set
   `DREVI_BRAND_MODEL=b` (or c) to switch. Per-design model choice (the
   pipeline's Brand Model Map) can come later.
8. **In-store walk-in counter**: old in-store session history is still in the
   DB and reachable at `/admin/exhibition` style URLs, but the in-store landing
   now goes straight to billing. If you ever want the old session list back,
   say so.
9. **`/admin/specs/<designId>`** is reachable from Studio, the master editor
   and the delivery intake, but has no nav entry of its own (by design — it's a
   per-design view). Flag if Rakesh wants a top-level specs queue screen.
