# Needed from Ansh

## Pending from you — 27 Sep 2026 (launch order)

Everything below is blocked on you; everything not listed is done and live.
Prod facts as of this morning: 248 buyers, all active, all with a login on
the firstname+3digits scheme (rotated 26 Sep, audited); 242 reachable on
WhatsApp, 6 without any phone.

### A. AiSensy — the launch send (rewritten 30 Sep: no passwords in templates)

Meta rejected the templates that carried Username / Password: a login code
may only travel in its fixed-wording Authentication category (no video, no
link). So neither template carries credentials any more. Each has a **URL
button** that opens the buyer's account in one tap — `https://<portal>/go/{{1}}`,
where `{{1}}` is that buyer's login token (built 30 Sep: table 0073, page
`/go/<token>`, admin "Copy link" / "New link" on every buyer). Passwords still
exist as the fallback on a new phone.

1. **Settle the portal domain FIRST.** The button's base URL is fixed when Meta
   approves the template. Today that is `https://drevi-wholesale-portal-swart.vercel.app`
   because `wholesale.drevifashion.com` is dead (item 14). AiSensy advises the
   business's own domain.
2. **Template 1 — Rakesh's greeting (Marketing, Hindi).** Header: Rakesh's
   video (`WhatsApp Video 2026-09-25 at 18.17.27.mp4`, 7 MB H.264, fits the
   16 MB limit as is). Body: the current caption with the login block
   (Link / Username / Password) replaced by
   `नीचे *Catalog खोलें* button दबाइए, आपका account सीधे खुल जाएगा।`
   No body variables. Buttons, **URL button first**: `Catalog खोलें` →
   `https://<domain>/go/{{1}}` (sample value `qYRtI0BmROLMNtO9ffouAA`), then the
   *Stop promotions* quick reply.
3. **Template 2 — walkthrough (Utility, English).** Header: the walkthrough
   video. Body:
   > *Welcome to the Drevi Wholesale Portal.*
   >
   > Hello {{1}}, your wholesale account is ready. Tap *Open catalogue* below to browse our full catalogue at wholesale rates, add items to your cart and send an order request. This video walks you through each step.
   >
   > Save this message and use the same button whenever you want to order.
   >
   > For any help, call us on +91 86553 55958.
   > Rakesh, Drevi Fashion

   `{{1}}` = shop name (sample `Royal Collection`). Button: `Open catalogue` →
   `https://<domain>/go/{{1}}`. Avoid "offer / sale / discount" wording or Meta
   moves it to Marketing.
4. **After approval:** one Live **API campaign** per template. Send me both
   campaign names exactly as typed, and the AiSensy API key if it changed.
5. **Check WhatsApp Manager for error 131037** (display name not approved) on
   +91 86553 55958 — the wallet's sends died on it; nothing sends until it is
   clear.
6. **Then it is mine:** host both videos, set `AISENSY_CAMPAIGN_GREETING`,
   `AISENSY_CAMPAIGN_LOGIN`, `AISENSY_GREETING_VIDEO_URL`,
   `AISENSY_LOGIN_VIDEO_URL`, and run `scripts/send-launch.mjs` — dry run
   first, then you, then 5 buyers, then the rest; greeting first, login
   message ~15 min later. It skips anyone already sent (state file + audit
   log). Prod dry run 30 Sep: **232 ready, 16 held** (3 on one shared number,
   1 already sent over WhatsApp Web, 3 non-mobile numbers, 9 no phone).

### B. Data the new home navigation exposes

7. ~~62 designs (65 rows) have NO category~~ — **DONE 27 Sep.** "You can
   always get the category from the SKU": the sheet sync and the Studio push
   now derive category / sub-category from the SKU codes whenever the sheet
   cell is blank, and the 75 blank prod rows were backfilled (46 Lehenga /
   Flared-Kali, 9 Palazzo Suit, 7 Pre-Draped Saree, 6 Skirt, 4 Mermaid, 3
   Indo-Western). Nothing left for you here.
8. **Traditional / Indo-Western (`style`)** is a Specs dropdown now but set on
   0 of 297 designs. It drives nothing until it is filled.
9. **Origin** is set on 155 of 297; the Shopify `custom.origin` metafield is
   simply absent on the rest.
10. **MRM-076 and PLZ-050:** copy was generated with the spec check bypassed.
    Verify their specs; I regenerate copy if anything was wrong.
11. **Six buyers with no phone at all:** house of arradhiya · Neeta Lahrani -
    Bespoke Couture · Namo Designer · Shilpa - Old Story · Ganpati Saree ·
    Mansi Vora. Numbers, or they get credentials another way.

### C. Decisions

12. **Supplier phone on tax documents.** `src/lib/supplier.ts` still prints the
    retail line (+91 88280 43555). Retail bills and wholesale invoices share
    that block — keep it, or split so wholesale invoices carry 86553 55958.
13. **Where alerts land.** Inquiry / order / pending-review alerts are
    addressed to the 88280 handset. Keep, or move to the wholesale line.
14. **wholesale.drevifashion.com** is still dead (DNS → Vercel, no domain on
    the project). Add the domain to the prod Vercel project + DNS; until then
    every link says drevi-wholesale-portal-swart.vercel.app. The dev project
    also lacks `NEXT_PUBLIC_PORTAL_URL`.
15. **Public onboarding page.** The three price-masked walkthroughs (Hindi,
    English, Gujarati) are in `~/Downloads/Drevi_Portal_Video/v3/`. Tell me
    where they live (Shopify page on the theme?) and I build it.
16. **Sheet sync retirement** (~end Sep, decided 2 Aug): say when and I flip
    `SHEET_SYNC_ENABLED=false` and drop the guard.
17. **One `PORTAL_PASSWORD_MASTER_KEY` across dev and prod** — still true.
    Rotating means re-encrypting every buyers.encrypted_password row. Low
    priority by your own call; noted so it is not forgotten.
18. **Signature image** for the invoice signatory block (from 14 Sep).
19. **FASHN credits** are still exhausted.
20. **Sheet-sync cron looks stalled.** The GitHub Actions job is meant to hit
    `/api/cron/sync-products` every 10 minutes, but prod's last sync ran at
    17:28 UTC on 26 Sep and none fired in the 10-minute window I watched after
    the category backfill. Likely cause: the Action's `PORTAL_URL` secret points
    at the dead wholesale.drevifashion.com. Either fix the domain (item 14) or
    point the secret at drevi-wholesale-portal-swart.vercel.app; say which and
    I check the Actions log.

---


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
