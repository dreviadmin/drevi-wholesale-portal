/**
 * Dev seeding: create Supabase Auth users for the three staff accounts and one
 * active test buyer, so login / catalog can be verified end-to-end.
 *
 *   npm run db:seed-auth
 *
 * Idempotent — re-running RESETS the passwords of every account listed below.
 * Requires the migration (npm run db:migrate) to have run first so the buyers /
 * staff_users rows exist.
 *
 * TARGET: dev by default. This script rewrites real people's passwords, so
 * production needs an explicit --prod and a typed confirmation. It used to load
 * .env.local unconditionally — which is PRODUCTION — so a bare run would have
 * silently overwritten the live staff credentials.
 *
 * These are DEV passwords for verification only. Real credentials are set by
 * Rakesh through the Phase 3 credential modal.
 */
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const target = process.argv.includes("--prod") || process.env.DB_TARGET === "prod" ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
dotenv.config({ path: envFile, override: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`);
  process.exit(1);
}
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? "unknown";
console.log(`Target: ${target.toUpperCase()} (${envFile}, project ${ref})`);

if (target === "prod") {
  console.log("\n⚠  PRODUCTION — this will REPLACE the passwords of the accounts below.");
  console.log("   Anyone currently using a different password will be locked out.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "reset production passwords" to continue: ');
  rl.close();
  if (answer.trim() !== "reset production passwords") {
    console.log("Aborted — nothing changed.");
    process.exit(1);
  }
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserByEmail(email) {
  // Paginate listUsers (no direct get-by-email in the admin API).
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureAuthUser(email, password) {
  const existing = await findUserByEmail(email);
  if (existing) {
    await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
    return { id: existing.id, created: false };
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, created: true };
}

// Ansh (31 Aug): the whole team logs in with <name>/<name>123 on BOTH
// environments for now. Ansh's own account is deliberately NOT in this list —
// resetting the super-admin's real password from a script would lock him out.
const STAFF = [
  { email: "arushi@drevifashion.com", password: "arushi123" },
  { email: "rakesh@drevifashion.com", password: "rakesh123" },
  { email: "grishma@drevifashion.com", password: "grishma123" },
  { email: "jyoti@drevifashion.com", password: "jyoti123" },
  { email: "riddhi@drevifashion.com", password: "riddhi123" },
];

const TEST_BUYER = {
  email: "buyer@example.com",
  password: "Tulip-Lotus-7382",
  business_name: "Sharma Boutique",
  owner_name: "Meera Sharma",
  phone: "+919812345678",
  city: "Pune",
};

async function main() {
  console.log("Seeding auth users…\n");

  for (const s of STAFF) {
    const { created } = await ensureAuthUser(s.email, s.password);
    console.log(`  staff   ${s.email}  →  ${s.password}  (${created ? "created" : "updated"})`);
  }

  // Test buyer: auth user + active buyers row — DEV ONLY. Production must
  // never grow an example.com buyer account.
  if (target === "prod") {
    console.log("\nDone. Log in at /login with any of the above. (Test buyer skipped on prod.)");
    return;
  }
  const { created } = await ensureAuthUser(TEST_BUYER.email, TEST_BUYER.password);
  const { error: upsertErr } = await admin.from("buyers").upsert(
    {
      email: TEST_BUYER.email,
      business_name: TEST_BUYER.business_name,
      owner_name: TEST_BUYER.owner_name,
      phone: TEST_BUYER.phone,
      city: TEST_BUYER.city,
      status: "active",
      source: "manual_admin",
      approved_at: new Date().toISOString(),
    },
    { onConflict: "email" },
  );
  if (upsertErr) throw upsertErr;
  console.log(`\n  buyer   ${TEST_BUYER.email}  →  ${TEST_BUYER.password}  (${created ? "created" : "updated"}, status=active)`);

  console.log("\nDone. Log in at /login with any of the above.");
}

main().catch((err) => {
  console.error("\nSeeding failed:", err.message);
  process.exit(1);
});
