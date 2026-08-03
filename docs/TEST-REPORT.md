# Test report — full portal pass (4 Aug 2026)

Scope: dev branch on localhost (dev Supabase), mobile-viewport sweep, and the
deployed dev site `drevi-wholesale-dev.vercel.app`. Everything below was
executed by driving the real UI (or the real API with a staff session) —
no mocked steps. Data side effects were reverted where noted.

## Result matrix

| # | Area | What was exercised | Result |
|---|------|--------------------|--------|
| T1 | Route sweep | 24 staff + buyer routes with content assertions | ✅ 24/24 |
| T2 | Delivery intake (v2) | Vendor chip → GST Pakka · 5% · incl. → new garment (Suit Set / Palazzo / PBL / size M @ ₹999) → SKU minted `DD-SUT-PLZ-046·PBL` → ident photo → Add to delivery → Save | ✅ receipt `GR-2026-08-04-001`; GST fields on the receipt; line M×1 @999; `receipt` movement; hidden product with HSN 6204; `last_cost` = ₹951.43 (ex-GST); vendor linked on design **and** product_vendor_info |
| T3 | Studio | Shoot on FRONT → Drive; Seedream generate → candidate; approve → production; crop + rotate → derived crop image | ✅ all four files in Drive under the auto-created `DD-SUT-PLZ-046-PBL` folder (`design__ident__01.jpg`, `front__src__01.jpg`, `front__gen__01.png`, `front__crop__01.jpg`) |
| T4 | Order lifecycle | `DX-20260717-020`: confirm → packed → dispatch (courier + AWB + tracking-sheet photo) → delivered; Download PDF; HSN chip editor; buyer edit sheet; Refresh from Catalog; bulk confirm ×2 from the list | ✅ stock −1 with `order` movements at confirm; tracking photo stored (`order-attachments`); fresh PDF has **HSN 6204** on lines, **no** "was ₹…" / override text, total ₹20,651; bulk "2 done" (both reverted afterwards) |
| T5 | Stock take | Manual SKU add → count 3 → commit; then reset back to 1 | ✅ `reset` movement with snapshot; line shows "kept at Rack A1 · test" (location field) |
| T6 | In-store | Buyer picker (no session) → catalog → cart → split-billing hints, tax, payment, **Taken by** → finalise | ✅ `IS-20260804-001` — source `in_store`, assisted_by recorded, HSN 6204 auto-attached to the line (order cancelled afterwards) |
| T7 | Admin regressions | Vendor search + detail (3 receipts incl. imports, lifetime spend); entity note added on vendor; LoV colour add → visible in SKU generator instantly → deactivate; dashboard custom date range | ✅ all |
| T8 | Mobile (375 px) | 10 key routes measured for horizontal overflow | ✅ 0 px overflow everywhere |
| T9 | Deployed dev site | Auth'd smoke on 5 admin routes; engine flags; one real Seedream run through `/api/pipeline/run` on Vercel | ✅ all 200; `fashn/seedream/openai` all enabled; generation produced `front__gen__02.png` in Drive |

Unit tests: 41/41 · `tsc --noEmit` clean.

## Defects found and fixed (commit `a150a3e`)

1. **Every in-app Drive upload failed** — `drive-design.ts` destructured
   `Readable` from a dynamic `import("node:stream")`, which comes back
   undefined in the Next server bundle → "Cannot read properties of undefined
   (reading 'from')". The photo migration script worked (plain Node), which is
   why this never surfaced until the UI test. Fixed with a top-level import.
2. **In-app shoots never lit the angle** — the Workbench and the generators
   read `design_angles.source_ref`, but only the old sheet sync ever wrote it;
   `uploadSource` / `applyImageDirectly` / `setAngleSource` set just
   `source_image_id`, so a shot angle stayed "Needs source" forever. All three
   now write `source_ref` too; the one affected dev row was backfilled (prod
   had none).
3. **App-logged deliveries lost SKU-level vendor attribution** — the
   `product_vendor_info` upsert in `saveDelivery` didn't carry `vendor_id`
   (imported rows have it). Now it does; the test SKU was backfilled.
4. Cosmetic: admin order lines showed the raw `made_to_order` state — now
   humanised ("made to order").

## Notes / by-design observations

- **Confirm does not block on stock** — confirming an order with 0 on hand
  drives `current_qty` negative. With a made-to-order catalog that is the
  correct behaviour (negative = owed to production), noting it here so it's a
  decision, not a surprise.
- `window.confirm` guards (bulk actions, cancels) behave normally in real
  browsers; the test driver had to stub them, which is expected.
- The extra Seedream candidate from the deployed-site test
  (`front__gen__02.png`) is left in review on `DD-SUT-PLZ-046` FRONT.
- Test residue kept deliberately: design `DD-SUT-PLZ-046·PBL` (+ its receipt
  `GR-2026-08-04-001`, Drive folder, "Rack A1 · test" location, Fouram note).
  Delete via the receipt page + Manage Catalog if unwanted — or keep it as a
  known-good demo design.

## What still needs a real device (Ansh)

The simulator can't prove these — a 10-minute phone pass:

1. **Camera capture** — Shoot / ident / tracking-sheet buttons should open the
   rear camera directly (`capture="environment"`), not the gallery.
2. **Label printing** — print a 38×25 mm tag from the receipt Save & Print
   path and check the browser print dialog picks up the label size.
3. **Offline hold** — put the phone in airplane mode mid in-store cart; the
   hold/draft should survive and sync when back online.
4. **WhatsApp share** — "WhatsApp buyer" / Share PDF from an order on the
   phone (share-sheet behaviour differs from desktop).
5. **QR scan** — scan a printed tag in Stock take and In-store (camera
   permission + focus on small labels).

## Still blocked on Ansh (unchanged, see NEEDED-FROM-ANSH.md)

- FASHN account credits (model-swap engine is wired but OutOfCredits).
- Vendor names for imported receipt rows 96 / 154 / 198.
- Drive folder tidy-ups (one misnamed folder, one loose file, one legacy
  folder name).
