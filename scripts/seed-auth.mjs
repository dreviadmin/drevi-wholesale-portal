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
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { generateMemorablePassword } from "./lib/password.mjs";

const buyerOnly = process.argv.includes("--buyer-only");
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

// Mirrors src/lib/crypto.ts: AES-256-GCM, payload = base64( iv[12] | tag[16] | ct ).
// Must stay byte-compatible or /admin/buyers "reveal password" cannot decrypt it.
function encryptPassword(plaintext) {
  const raw = process.env.PORTAL_PASSWORD_MASTER_KEY;
  if (!raw) throw new Error("PORTAL_PASSWORD_MASTER_KEY missing — buyer credentials cannot be written.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("PORTAL_PASSWORD_MASTER_KEY must decode to 32 bytes.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

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
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
    if (error) throw error;
    return { id: existing.id, created: false };
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, created: true };
}

// Passwords are GENERATED on every run and written to a gitignored file (see
// record() below) — never put a password in this file. Ansh's own account is
// deliberately NOT in this list: resetting the super-admin's real password from
// a script would lock him out. To rotate live staff passwords use
// scripts/rotate-staff-passwords.mjs.
const STAFF = [
  "arushi@drevifashion.com",
  "rakesh@drevifashion.com",
  "grishma@drevifashion.com",
  "jyoti@drevifashion.com",
  "riddhi@drevifashion.com",
].map((email) => ({ email, password: generateMemorablePassword() }));

const TEST_BUYER = {
  email: "buyer@example.com",
  password: generateMemorablePassword(),
  business_name: "Sharma Boutique",
  owner_name: "Meera Sharma",
  phone: "+919812345678",
  city: "Pune",
};

// Passwords go to a gitignored, owner-only file — never to the terminal log.
// Each one is written the moment it is set, so a run that stops halfway, and
// the prod run (which ends before the test buyer), still leave every changed
// password on record.
const pwFile = `.local/seeded-passwords-${target}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
let recorded = 0;
function record(email, password) {
  if (!existsSync(".local")) mkdirSync(".local");
  appendFileSync(pwFile, `${email}  ${password}\n`, { mode: 0o600 });
  recorded++;
}

async function main() {
  console.log("Seeding auth users…\n");

  for (const s of buyerOnly ? [] : STAFF) {
    const { created } = await ensureAuthUser(s.email, s.password);
    record(s.email, s.password);
    console.log(`  staff   ${s.email}  (${created ? "created" : "updated"})`);
  }

  // Test buyer: auth user + active buyers row — DEV ONLY. Production must
  // never grow an example.com buyer account.
  if (target === "prod") {
    console.log(recorded > 0
      ? `\nDone. Passwords are in ${pwFile} (not printed). (Test buyer skipped on prod.)`
      : "\nNothing changed. (Test buyer skipped on prod.)");
    return;
  }
  const { created } = await ensureAuthUser(TEST_BUYER.email, TEST_BUYER.password);
  record(TEST_BUYER.email, TEST_BUYER.password);

  // encrypted_password is NOT optional. login/actions.ts, /home, /cart and
  // /account/orders all select buyers with .not("encrypted_password", "is", null),
  // so a buyer row without it authenticates and then bounces straight back to
  // /login — which is exactly what this script used to produce.
  const row = {
    email: TEST_BUYER.email,
    business_name: TEST_BUYER.business_name,
    owner_name: TEST_BUYER.owner_name,
    phone: TEST_BUYER.phone,
    city: TEST_BUYER.city,
    status: "active",
    source: "manual_admin",
    encrypted_password: encryptPassword(TEST_BUYER.password),
    approved_at: new Date().toISOString(),
  };

  // NOT upsert(onConflict:"email"): buyers.email has no unique constraint
  // (duplicate buyer rows are legitimate), so that call errors outright.
  const { data: existing } = await admin.from("buyers").select("id").eq("email", TEST_BUYER.email).limit(1);
  if (existing && existing.length > 0) {
    const { error } = await admin.from("buyers").update(row).eq("id", existing[0].id);
    if (error) throw error;
  } else {
    const { error } = await admin.from("buyers").insert(row);
    if (error) throw error;
  }
  console.log(`\n  buyer   ${TEST_BUYER.email}  (${created ? "created" : "updated"}, status=active)`);

  console.log(`\nDone. Passwords are in ${pwFile} (not printed) — log in at /login with those.`);
}

main().catch((err) => {
  console.error("\nSeeding failed:", err.message);
  if (recorded > 0) console.error(`Passwords already changed are in ${pwFile}.`);
  process.exit(1);
});
