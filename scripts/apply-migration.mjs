/**
 * Apply every SQL file in supabase/migrations (sorted). Two credential modes,
 * either works — set ONE in .env.local (both are ops-only, never committed):
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_...   Personal Access Token (Management API)
 *     Create at https://supabase.com/dashboard/account/tokens
 *
 *   SUPABASE_DB_URL=postgresql://... Direct/session-pooler connection string
 *     Dashboard → Connect → Session pooler
 *
 *   npm run db:migrate
 *
 * Migrations are idempotent, so this is safe to re-run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error("No .sql files found in supabase/migrations.");
  process.exit(1);
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
const dbUrl = process.env.SUPABASE_DB_URL;

async function viaManagementApi() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const ref = supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref) throw new Error("Could not derive project ref from NEXT_PUBLIC_SUPABASE_URL.");
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
      "\nNo DB credential found. Add ONE of these to .env.local:\n" +
        "  SUPABASE_ACCESS_TOKEN=sbp_...   (Personal Access Token — easiest)\n" +
        "  SUPABASE_DB_URL=postgresql://... (Session pooler connection string)\n",
    );
    process.exit(1);
  }
} catch (err) {
  console.error("\nMigration failed:\n", err.message);
  process.exit(1);
}
