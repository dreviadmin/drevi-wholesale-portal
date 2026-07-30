# Needed from Ansh

Living checklist of everything that is blocked on you — kept current through the
UX sprint (30 Jul 2026). Everything else in the sprint is done and verified on
dev; none of it touches production.

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
