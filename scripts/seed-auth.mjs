/**
 * Dev seeding: create Supabase Auth users for the three staff accounts and one
 * active test buyer, so login / catalog can be verified end-to-end.
 *
 *   npm run db:seed-auth
 *
 * Idempotent — re-running resets the known dev passwords. Uses the service-role
 * key from .env.local. Requires the migration (npm run db:migrate) to have run
 * first so the buyers / staff_users rows exist.
 *
 * These are DEV passwords for verification only. Real credentials are set by
 * Rakesh through the Phase 3 credential modal.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
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

const STAFF = [
  { email: "ansh@drevifashion.com", password: "Drevi-Super-2026" },
  { email: "rakesh@drevifashion.com", password: "Drevi-Admin-2026" },
  { email: "grishma@drevifashion.com", password: "Drevi-Staff-2026" },
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

  // Test buyer: auth user + active buyers row.
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
