/**
 * SUPERSEDED (18 Sep) — do not run. Kept as a signpost, not as a tool.
 *
 * This script handled ONE direction of the imagery rule: a design whose
 * wholesale group showed a catalog photo but whose Studio front was empty.
 * The owner's full rule (17 Sep) is wider than that — a thumbnail also implies
 * a SOURCE, a front implies a source of its own, and any image on any channel
 * implies both a thumbnail and a front. Those invariants are now enforced
 * together, server-side, by ONE implementation:
 *
 *   src/lib/imagery-sweep.ts              sweepDesignImagery({ dryRun, limit })
 *   src/app/api/admin/imagery-sweep/route.ts   POST, admin-gated
 *
 *     curl -X POST "$PORTAL/api/admin/imagery-sweep" \
 *          -H 'content-type: application/json' -d '{"dryRun":true}'
 *
 * Running from the server matters here: only the deployed environment holds the
 * Google service-account credentials, so only there can the sweep create a
 * design's Drive folder and put the thumbnail inside it, as the rule asks. A
 * local script falls back to the Supabase bucket instead.
 *
 * To find the SKUs that have no photo on any channel — the gaps no sweep can
 * close because there is nothing to copy — use the read-only report:
 *
 *     node scripts/imagery-report.mjs [--prod]
 */
console.error(
  "backfill-front-from-thumbnail.mjs is superseded.\n" +
    "Use POST /api/admin/imagery-sweep (src/lib/imagery-sweep.ts) for the repair,\n" +
    "and node scripts/imagery-report.mjs for the no-image SKU list.",
);
process.exit(1);
