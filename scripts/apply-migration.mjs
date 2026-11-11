/**
 * Apply SQL files from supabase/migrations (sorted). Two credential modes,
 * either works (both are ops-only, never committed):
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_...   Personal Access Token (Management API),
 *     in .env.local. Create at https://supabase.com/dashboard/account/tokens
 *
 *   SUPABASE_DB_URL=postgresql://... Direct/session-pooler connection string,
 *     in the TARGET's own env file. Dashboard → Connect → Session pooler
 *
 *   npm run db:migrate -- --only=0075        just the named file(s) — the normal case
 *   npm run db:migrate -- --all              the whole chain (see below)
 *   … --prod (or DB_TARGET=prod)             production instead of dev
 *
 * A full replay is NOT harmless (audit round 2): old data backfills re-run and
 * undo later staff decisions, and two files re-narrow CHECK constraints. So a
 * bare run applies nothing and prints the usage; the whole chain needs --all.
 * The rule lives in scripts/lib/migration-plan.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { refuseDevWithoutEnvFile } from "./lib/dev-env-guard.mjs";
import { planMigrations, REPLAY_WARNING } from "./lib/migration-plan.mjs";

// TARGET SELECTION — dev is the default, prod needs an explicit flag.
//
// This script used to load .env.local unconditionally, which is PRODUCTION.
// While the retrofit is dev-only, a bare `npm run db:migrate` must never be
// able to reach prod by accident. Pass --prod (or DB_TARGET=prod) to opt in.
const target = process.argv.includes("--prod") || process.env.DB_TARGET === "prod" ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";

// Audit round 2: with .env.development.local missing, the two loads below left
// .env.local's PRODUCTION project in place — "Target: DEV" on screen, SQL sent
// to prod. Refuse instead. Prod runs are unchanged.
refuseDevWithoutEnvFile(target);

// The Personal Access Token is account-level and lives in .env.local, so load
// that first for credentials — then let the target file win on WHICH project.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: envFile, override: true });

// SUPABASE_DB_URL is project-specific. Only trust it when the target's own env
// file supplied it, else fall through to the Management API + project ref.
const targetEnv = dotenv.config({ path: envFile, processEnv: {} }).parsed ?? {};
if (!targetEnv.SUPABASE_DB_URL) delete process.env.SUPABASE_DB_URL;

// Second rail: a dev file that exists but holds PRODUCTION values (copied from
// .env.local and never edited) must not pass for dev either.
const PROD_REF = "cofarxgywnrdjbizxbxw";
if (target === "dev" && [targetEnv.NEXT_PUBLIC_SUPABASE_URL, targetEnv.SUPABASE_DB_URL].some((v) => v?.includes(PROD_REF))) {
  console.error(`${envFile} points at the PRODUCTION project (${PROD_REF}) — refusing a DEV run. Fix the file, or pass --prod deliberately.`);
  process.exit(1);
}

console.log(`Target: ${target.toUpperCase()} (${envFile})`);
if (target === "prod") {
  console.log("⚠  PRODUCTION — this is the live portal. Ctrl-C now if that is not what you meant.");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "supabase", "migrations");
// --only=0054,0055 applies just those files, in sorted order; --all replays
// the whole chain. Naming the files was already the safer habit before the
// gate: ONE transient failure anywhere in a full replay blocks every file
// after it, which is exactly what happened on 20 Sep — the Management API
// returned a 500 re-running 0053, an already applied migration, and 0054/0055
// behind it never ran. A full replay also re-runs old data backfills, so it
// is no longer what a bare `npm run db:migrate` does.
const plan = planMigrations(readdirSync(migrationsDir), process.argv);
if ("error" in plan) {
  console.error(plan.error);
  process.exit(1);
}
const { files } = plan;
if (plan.mode === "only") console.log(`--only: ${files.join(", ")}`);
else console.log(`--all: ${files.length} files (${files[0]} … ${files[files.length - 1]})\n${REPLAY_WARNING}`);

const token = process.env.SUPABASE_ACCESS_TOKEN;
const dbUrl = process.env.SUPABASE_DB_URL;

async function viaManagementApi() {
  // For a DEV run the project comes from the dev file only. Falling back to
  // the merged process.env would let a dev file that lacks the URL inherit
  // .env.local's — production — which is the bug the guard above closes.
  // A prod run keeps its old lookup (its target file IS .env.local).
  const supabaseUrl = targetEnv.NEXT_PUBLIC_SUPABASE_URL ?? (target === "prod" ? process.env.NEXT_PUBLIC_SUPABASE_URL : undefined) ?? "";
  const ref = supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref) throw new Error(`Could not derive project ref from NEXT_PUBLIC_SUPABASE_URL in ${envFile}.`);
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  console.log(`Applying ${files.length} migration(s) via Management API (project ${ref})…`);
  for (const file of files) {
    const query = readFileSync(join(migrationsDir, file), "utf8");
    process.stdout.write(`  • ${file} … `);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text.slice(0, 300)}`);
    }
    console.log("ok");
  }
  console.log("All migrations applied.");
}

async function viaConnectionString() {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`Connected. Applying ${files.length} migration(s)…`);
  try {
    for (const file of files) {
      process.stdout.write(`  • ${file} … `);
      await client.query(readFileSync(join(migrationsDir, file), "utf8"));
      console.log("ok");
    }
    console.log("All migrations applied.");
  } finally {
    await client.end();
  }
}

try {
  if (token) await viaManagementApi();
  else if (dbUrl) await viaConnectionString();
  else {
    console.error(
      "\nNo DB credential found. Add ONE of these:\n" +
        "  SUPABASE_ACCESS_TOKEN=sbp_...   to .env.local (Personal Access Token — easiest)\n" +
        `  SUPABASE_DB_URL=postgresql://... to ${envFile} (Session pooler connection string)\n`,
    );
    process.exit(1);
  }
} catch (err) {
  console.error("\nMigration failed:\n", err.message);
  process.exit(1);
}
