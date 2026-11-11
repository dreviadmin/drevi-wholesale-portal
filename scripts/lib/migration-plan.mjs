/**
 * Which migration files a db:migrate run applies — kept out of
 * apply-migration.mjs so the rule is unit-tested (migration-plan.test.ts).
 *
 * Audit round 2: replaying the WHOLE chain is no longer the default. It is not
 * the harmless no-op the old header promised. Several early files carry data
 * backfills that run again on every replay and undo later staff decisions
 * (0062 re-shows SKUs staff hid from buyers, 0053 turns "Coloured" backgrounds
 * back to white, 0050 re-pins wholesale overrides staff cleared, 0023 re-adds
 * the lifestyle angle wherever it was removed), and 0029/0046 re-narrow CHECK
 * constraints, so a database holding nano_banana/matte jobs or
 * receipt_reversed movements stops the chain there with every later file
 * unapplied. So a run names its files with --only=NNNN, or says --all.
 */

/** What a full replay re-runs, printed before an --all run starts. */
export const REPLAY_WARNING = [
  "Re-applying the WHOLE migration chain. Old data backfills re-run too:",
  "  0062 makes every live-wholesale SKU buyer-visible again (undoes 'Hide from buyer catalog')",
  "  0053 turns 'auto' (Coloured) backgrounds back to white",
  "  0050 re-pins wholesale overrides that staff cleared",
  "  0023 re-adds the lifestyle angle to every design that no longer has one",
  "  0029/0046 re-narrow CHECK constraints and fail on newer job types or receipt reversals",
  "Prefer --only=NNNN for new files.",
].join("\n");

export const USAGE = [
  "Name the migrations to apply:",
  "  npm run db:migrate -- --only=0075          just those files (comma-separated)",
  "  npm run db:migrate -- --all                the whole chain (re-runs old backfills)",
  "Add --prod (or DB_TARGET=prod) for production; dev is the default.",
].join("\n");

/**
 * @param {string[]} allFiles  every file name in supabase/migrations
 * @param {string[]} argv      process.argv (or just the flags)
 * @returns {{ mode: "all" | "only", files: string[] } | { error: string }}
 */
export function planMigrations(allFiles, argv) {
  const all = argv.includes("--all");
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  if (all && onlyArg) return { error: "Pass --all or --only=…, not both." };
  if (!all && !onlyArg) return { error: USAGE };

  const sql = allFiles.filter((f) => f.endsWith(".sql")).sort();
  if (all) {
    if (sql.length === 0) return { error: "No .sql files found in supabase/migrations." };
    return { mode: "all", files: sql };
  }

  // --only=0054,0055 applies just those files, in sorted order. Matching is
  // unchanged from before the gate: the exact name or any name it prefixes.
  const only = onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const files = sql.filter((f) => only.some((o) => f === o || f.startsWith(`${o}_`) || f.startsWith(o)));
  if (files.length === 0) return { error: `--only=${only.join(",")} matched no migration file.` };
  return { mode: "only", files };
}
