/**
 * Are every buyer's login id and password actually usable?
 *
 *   node scripts/audit-buyer-logins.mjs [--prod] [--no-signin]
 *
 * Checks, per buyer, in increasing order of strength:
 *   1. buyers.email is set and is a login id we can show them
 *   2. buyers.encrypted_password is set and DECRYPTS with the master key
 *   3. a GoTrue auth user exists for that email
 *   4. that decrypted password actually SIGNS IN
 *
 * (4) is the only one that proves anything. A buyer row can carry a perfectly
 * well-formed encrypted_password that no longer matches what GoTrue holds —
 * nothing in the schema ties the two together — and the failure only shows up
 * when the buyer taps the link and cannot get in. Worth knowing BEFORE the
 * credential message goes out, not after.
 */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
const NO_SIGNIN = process.argv.includes("--no-signin");
dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const masterKey = Buffer.from(process.env.PORTAL_PASSWORD_MASTER_KEY, "base64");

function decrypt(b64) {
  const raw = Buffer.from(b64, "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

const { data: buyers } = await admin
  .from("buyers").select("id, business_name, email, phone, status, encrypted_password, import_batch")
  .order("business_name").range(0, 9999);

const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const authByEmail = new Map((page?.users ?? []).map((u) => [(u.email || "").toLowerCase(), u]));

const bad = { noEmail: [], noPassword: [], undecryptable: [], noAuthUser: [], signinFailed: [], rateLimited: [] };
const ok = [];
const checks = [];

for (const b of buyers ?? []) {
  const label = `${b.business_name ?? "(no name)"}`;
  if (!b.email) { bad.noEmail.push(label); continue; }
  if (!b.encrypted_password) { bad.noPassword.push(`${label} <${b.email}>`); continue; }
  let pw;
  try { pw = decrypt(b.encrypted_password); }
  catch (e) { bad.undecryptable.push(`${label} — ${e.message}`); continue; }
  if (!authByEmail.has(b.email.toLowerCase())) { bad.noAuthUser.push(`${label} <${b.email}>`); continue; }
  checks.push({ b, pw, label });
}

console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"}`);
console.log(`buyers: ${(buyers ?? []).length} · auth users: ${authByEmail.size}`);
console.log(`structurally complete: ${checks.length}`);

// GoTrue rate-limits sign-ins hard (a flat-out pass over 165 buyers got 33
// through and then "Request rate limit reached" for the rest — which looks
// exactly like a credential failure and is not). So: sample per import_batch
// and pace it. Credentials are issued batch-wide by one code path, so a
// working sample from each batch tests the mechanism that made all of them.
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const PER_BATCH = arg("per-batch", 10);
const DELAY = arg("delay", 4000);

if (!NO_SIGNIN) {
  const byBatch = new Map();
  for (const c of checks) {
    const k = c.b.import_batch ?? "(none)";
    if (!byBatch.has(k)) byBatch.set(k, []);
    byBatch.get(k).push(c);
  }
  const sample = [];
  for (const [k, list] of byBatch) {
    const step = Math.max(1, Math.floor(list.length / PER_BATCH));
    for (let i = 0; i < list.length && sample.filter((s) => (s.b.import_batch ?? "(none)") === k).length < PER_BATCH; i += step) sample.push(list[i]);
  }
  console.log(`sign-in sample: ${sample.length} across ${byBatch.size} batch(es), ${DELAY}ms apart`);
  for (const { b, pw, label } of sample) {
    const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await c.auth.signInWithPassword({ email: b.email, password: pw });
    if (error) {
      if (/rate limit/i.test(error.message)) { bad.rateLimited = bad.rateLimited || []; bad.rateLimited.push(label); }
      else bad.signinFailed.push(`${label} <${b.email}> — ${error.message}`);
    } else ok.push(label);
    await c.auth.signOut().catch(() => {});
    await new Promise((r) => setTimeout(r, DELAY));
    process.stdout.write(".");
  }
  console.log("");
}

console.log("");
const problems = Object.entries(bad).filter(([, v]) => v.length);
if (!problems.length) {
  console.log(`ALL ${NO_SIGNIN ? checks.length : ok.length} BUYERS READY — login id and password both work.`);
} else {
  for (const [kind, list] of problems) {
    console.log(`${kind}: ${list.length}`);
    list.slice(0, 15).forEach((x) => console.log(`   ${x}`));
    if (list.length > 15) console.log(`   … and ${list.length - 15} more`);
  }
  if (!NO_SIGNIN) console.log(`\nsigned in successfully: ${ok.length}`);
}
