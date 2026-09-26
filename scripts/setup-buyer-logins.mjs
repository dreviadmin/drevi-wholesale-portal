/**
 * Give every buyer a username login — the first word of their business name.
 *
 *   node scripts/setup-buyer-logins.mjs --dry-run          # dev, show the plan
 *   node scripts/setup-buyer-logins.mjs                    # dev, apply
 *   node scripts/setup-buyer-logins.mjs --prod --dry-run   # prod, show the plan
 *   node scripts/setup-buyer-logins.mjs --prod             # prod, apply (typed confirmation)
 *
 * TARGET SELECTION mirrors scripts/set-all-stock.mjs — dev by default, prod
 * needs an explicit flag AND a typed confirmation, because this rewrites
 * buyer login identities and passwords.
 *
 * Owner's rule: "Do not use email at all setup their brand's first name as
 * username." Buyers type a bare username (e.g. royal) + password. Supabase
 * Auth still requires an email, so each buyer gets a synthetic one they never
 * see: <username>@buyers.drevifashion.com — the login action resolves bare
 * ids to that domain (lookup-first against staff_users).
 *
 * Per buyer this replicates setCredentials() in src/app/admin/buyers/actions.ts:
 * GoTrue user (create or update, email_confirm), buyers.email = synthetic,
 * buyers.encrypted_password = AES-GCM ciphertext, audit row credential_created.
 * That action and src/lib/crypto.ts are `import "server-only"`, so a node
 * script cannot import them — the credential and cipher shapes are duplicated
 * here DELIBERATELY and kept identical; if either changes, change this file
 * with it. Unlike setCredentials, approved_by/approved_at are left untouched:
 * a bulk script is not an approver.
 *
 * USERNAME: business_name -> trim -> drop a leading article (the/a/an) ->
 * first word -> lowercase -> strip to [a-z0-9]. Password: <username>123.
 *
 * COLLISIONS (real, from prod data):
 *  (a) the same business captured twice (same full name, same phone) — the row
 *      that HAS ORDERS is credentialed (else the older created_at); the twin
 *      is skipped and printed as a manual-merge item.
 *  (b) genuinely different businesses sharing a first word — the older
 *      created_at keeps the short username; later ones get the full
 *      business-name slug (e.g. houseofreet). Deterministic, printed in plan.
 * Any overlap with a staff username (local part of a staff_users email) is
 * refused loudly — staff and buyers share one Supabase Auth pool.
 */
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import { generateBuyerPassword } from "./lib/password.mjs";
import dotenv from "dotenv";

const BUYER_LOGIN_DOMAIN = "buyers.drevifashion.com"; // keep equal to src/lib/share.ts
const STAFF_DOMAIN = "drevifashion.com";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const target = has("--prod") || process.env.DB_TARGET === "prod" ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
const dryRun = has("--dry-run");

dotenv.config({ path: envFile, override: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const masterKeyB64 = process.env.PORTAL_PASSWORD_MASTER_KEY;
if (!url || !key || !masterKeyB64) {
  console.error(`Missing Supabase/master-key env in ${envFile}`);
  process.exit(1);
}
const masterKey = Buffer.from(masterKeyB64, "base64");
if (masterKey.length !== 32) {
  console.error("PORTAL_PASSWORD_MASTER_KEY must decode to 32 bytes (base64-encoded AES-256 key).");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const ref = url.match(/https:\/\/([a-z0-9]+)\./)?.[1];
console.log(`Target: ${target.toUpperCase()} (${envFile}, project ${ref})`);
console.log(dryRun ? "DRY RUN — nothing will be written\n" : "APPLYING\n");

if (target === "prod" && !dryRun) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This rewrites buyer logins and passwords on PRODUCTION. Type the project ref (${ref}) to continue: `,
  );
  rl.close();
  if (answer.trim() !== ref) {
    console.error("Confirmation did not match — aborting.");
    process.exit(1);
  }
}

// Same cipher shape as src/lib/crypto.ts: base64( iv[12] | authTag[16] | ct ).
function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function nameWords(businessName) {
  const words = (businessName ?? "").trim().split(/\s+/).filter(Boolean);
  // "THE ROYAL VIVA" logs in as royal, not the — but a name that IS only an
  // article keeps it rather than emptying out.
  if (words.length > 1 && /^(the|a|an)$/i.test(words[0])) words.shift();
  return words;
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const shortUsername = (name) => slugify(nameWords(name)[0] ?? "");
const fullUsername = (name) => slugify(nameWords(name).join(""));

// ── Load ────────────────────────────────────────────────────────────────────
const { data: staffRows, error: sErr } = await admin.from("staff_users").select("email");
if (sErr) throw sErr;
const staffUsernames = new Set(staffRows.map((s) => s.email.split("@")[0].toLowerCase()));

const { data: buyers, error: bErr } = await admin
  .from("buyers")
  .select("id, business_name, owner_name, phone, email, status, created_at, encrypted_password")
  .order("created_at", { ascending: true });
if (bErr) throw bErr;

const { data: orderRows, error: oErr } = await admin.from("orders").select("buyer_id");
if (oErr) throw oErr;
const buyersWithOrders = new Set(orderRows.map((o) => o.buyer_id));

console.log(`${buyers.length} buyers, ${staffUsernames.size} staff usernames\n`);

// ── Plan ────────────────────────────────────────────────────────────────────
// Each entry: { buyer, username?, password?, action } — action is what the
// table prints, updated in place by the real run.
const plan = [];
const candidates = [];

for (const b of buyers) {
  if (b.encrypted_password) {
    // Already credentialed (e.g. a real email like buyer@example.com, or the
    // dev staff-domain test login) — never overwrite a working password.
    plan.push({ buyer: b, action: `skip: already credentialed (${b.email})` });
  } else if (b.status === "suspended") {
    plan.push({ buyer: b, action: "skip: suspended" });
  } else if (b.status === "rejected") {
    // Not in the owner's skip list, but credentialing would silently
    // re-activate a rejected buyer — surface it instead.
    plan.push({ buyer: b, action: "skip: rejected" });
  } else if (!fullUsername(b.business_name)) {
    plan.push({ buyer: b, action: "skip: no business name" });
  } else {
    candidates.push(b);
  }
}

// (a) Same business captured twice: group by the full-name slug so casing and
// spacing differences still collapse. Keeper = has orders, else older row.
const byFullSlug = new Map();
for (const b of candidates) {
  const k = fullUsername(b.business_name);
  if (!byFullSlug.has(k)) byFullSlug.set(k, []);
  byFullSlug.get(k).push(b);
}
const keepers = [];
for (const group of byFullSlug.values()) {
  const sorted = [...group].sort((x, y) => {
    const xo = buyersWithOrders.has(x.id) ? 0 : 1;
    const yo = buyersWithOrders.has(y.id) ? 0 : 1;
    return xo !== yo ? xo - yo : x.created_at.localeCompare(y.created_at);
  });
  keepers.push(sorted[0]);
  for (const twin of sorted.slice(1)) {
    plan.push({
      buyer: twin,
      action: `skip: duplicate of ${sorted[0].id} (phone ${twin.phone ?? "—"}), needs manual merge`,
    });
  }
}
keepers.sort((x, y) => x.created_at.localeCompare(y.created_at));

// (b) First-word collisions between different businesses, plus staff overlap.
// Seed with every already-credentialed buyer-domain local part: on a re-run a
// NEW buyer must never be handed a username an existing login owns — the
// GoTrue update would silently overwrite that login's password and point two
// buyer rows at one identity.
const taken = new Set();
const suffix = `@${BUYER_LOGIN_DOMAIN}`;
for (const b of buyers) {
  if (b.encrypted_password && b.email?.toLowerCase().endsWith(suffix)) {
    taken.add(b.email.toLowerCase().slice(0, -suffix.length));
  }
}
for (const b of keepers) {
  const short = shortUsername(b.business_name);
  // Older created_at keeps the short username; later ones fall back to the
  // full business-name slug (unique here — duplicates were removed above).
  const username = taken.has(short) ? fullUsername(b.business_name) : short;
  if (staffUsernames.has(username)) {
    plan.push({ buyer: b, action: `REFUSED: "${username}" collides with staff username ${username}@${STAFF_DOMAIN} — set manually` });
    continue;
  }
  if (taken.has(username)) {
    plan.push({ buyer: b, action: `REFUSED: full slug "${username}" already taken — set manually` });
    continue;
  }
  // WAS `${username}123`, which phone keyboards and password managers flag as
  // a breached password, and which anyone knowing the shop name could guess.
  const password = generateBuyerPassword(b.owner_name, b.business_name);
  if (password.length < 6) {
    // GoTrue's minimum password length would reject it anyway.
    plan.push({ buyer: b, action: `REFUSED: "${username}" too short for the password policy — set manually` });
    continue;
  }
  taken.add(username);
  plan.push({ buyer: b, username, password, action: dryRun ? "would credential" : "pending" });
}

// Stable, readable order: keep the buyers' created_at order.
plan.sort((x, y) => x.buyer.created_at.localeCompare(y.buyer.created_at));

function printTable(title) {
  console.log(title);
  console.log(`${"business_name".padEnd(32)} -> ${"username".padEnd(18)} ${"password".padEnd(22)} action`);
  for (const p of plan) {
    const name = (p.buyer.business_name ?? "(no name)").slice(0, 30);
    console.log(`${name.padEnd(32)} -> ${(p.username ?? "—").padEnd(18)} ${(p.password ?? "—").padEnd(22)} ${p.action}`);
  }
  console.log("");
}

if (dryRun) {
  printTable("PLAN (dry run)");
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
// One listUsers pass instead of a lookup per buyer (same paging discipline as
// findAuthUserId in src/app/admin/buyers/actions.ts).
const authIdByEmail = new Map();
for (let page = 1; page <= 20; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw error;
  for (const u of data.users) if (u.email) authIdByEmail.set(u.email.toLowerCase(), u.id);
  if (data.users.length < 200) break;
}

let credentialed = 0;
let failed = 0;
for (const p of plan) {
  if (!p.username) continue;
  const email = `${p.username}@${BUYER_LOGIN_DOMAIN}`;
  try {
    const existing = authIdByEmail.get(email);
    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing, { password: p.password, email_confirm: true });
      if (error) throw error;
    } else {
      const { error } = await admin.auth.admin.createUser({ email, password: p.password, email_confirm: true });
      if (error) throw error;
    }

    // Mirrors setCredentials: email + AES ciphertext + active. approved_by /
    // approved_at deliberately untouched (see header).
    const { error: uErr } = await admin
      .from("buyers")
      .update({ email, encrypted_password: encryptPassword(p.password), status: "active" })
      .eq("id", p.buyer.id);
    if (uErr) throw uErr;

    // Same row shape as writeAuditEvent (src/lib/audit.ts). NEVER the password.
    const { error: aErr } = await admin.from("auth_audit_log").insert({
      event_type: "credential_created",
      buyer_id: p.buyer.id,
      staff_user_id: null,
      ip_address: null,
      user_agent: null,
      notes: `setup-buyer-logins.mjs: username ${p.username}`,
    });
    if (aErr) console.error(`  audit insert failed for ${p.username}: ${aErr.message}`);

    p.action = existing ? "credentialed (auth user updated)" : "credentialed (auth user created)";
    credentialed++;
  } catch (e) {
    p.action = `FAILED: ${e.message}`;
    failed++;
  }
}

printTable("RESULT");
console.log(`credentialed : ${credentialed}`);
console.log(`skipped      : ${plan.filter((p) => p.action.startsWith("skip")).length}`);
console.log(`refused      : ${plan.filter((p) => p.action.startsWith("REFUSED")).length}`);
if (failed) {
  console.log(`FAILURES     : ${failed}`);
  process.exitCode = 1;
}
