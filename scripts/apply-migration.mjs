/**
 * Apply every SQL file in supabase/migrations (sorted) to the database named by
 * SUPABASE_DB_URL. Idempotent migrations make this safe to re-run.
 *
 *   npm run db:migrate
 *
 * SUPABASE_DB_URL is the direct connection string from
 *   Supabase dashboard → Project Settings → Database → Connection string → URI
 * (port 5432, with the DB password substituted). It is server/ops-only and must
 * never be committed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "supabase", "migrations");

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    "\nMissing SUPABASE_DB_URL.\n" +
      "Add the Supabase direct connection string to .env.local:\n" +
      "  SUPABASE_DB_URL=postgresql://postgres:[PASSWORD]@db.<ref>.supabase.co:5432/postgres\n" +
      "(Dashboard → Project Settings → Database → Connection string → URI.)\n",
  );
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("No .sql files found in supabase/migrations.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`Connected. Applying ${files.length} migration file(s)…`);
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    process.stdout.write(`  • ${file} … `);
    await client.query(sql);
    console.log("ok");
  }
  console.log("All migrations applied.");
} catch (err) {
  console.error("\nMigration failed:\n", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
