/**
 * Re-issue every buyer's password on the memorable scheme.
 *
 *   node scripts/rotate-buyer-passwords.mjs [--prod] [--dry-run]
 *
 * WHY: passwords were bulk-issued as <username>xdrevi (and once as
 * <username>123). Both are derivable by anyone who knows the shop name, and a
 * trailing "123" is flagged as breached by phone keyboards and password
 * managers. This moves every buyer onto generateBuyerPassword() —
 * Word-Word-4digits — which is what the admin's own credential button and
 * staff creation have always issued.
 *
 * SAFE TO RUN ONLY BECAUSE NOTHING HAS BEEN SENT: auth_audit_log carries zero
 * credential-share events and zero buyer logins (every login_success row is a
 * staff one). Re-check both before running this again — once a buyer has been
 * told their password, rotating it silently locks them out.
 *
 * Writes GoTrue and buyers.encrypted_password together, one buyer at a time,
 * and logs a credential_created audit row. A buyer whose GoTrue update fails
 * keeps its OLD stored password rather than being left with a row claiming a
 * password that does not work.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { generateBuyerPassword } from "./lib/password.mjs";

const PROD = process.argv.includes("--prod");
const DRY = process.argv.includes("--dry-run");
dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const masterKey = Buffer.from(process.env.PORTAL_PASSWORD_MASTER_KEY, "base64");

function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

// Refuse to rotate behind a buyer's back.
const { data: audit } = await admin.from("auth_audit_log").select("event_type, buyer_id").range(0, 9999);
const shares = (audit ?? []).filter((r) => /shared|sent/i.test(r.event_type));
const buyerLogins = (audit ?? []).filter((r) => r.event_type === "login_success" && r.buyer_id);
console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"}`);
console.log(`credential-share events: ${shares.length} · buyer logins: ${buyerLogins.length}`);
const FORCE = process.argv.includes("--force");
if (shares.length || buyerLogins.length) {
  console.error("\nSTOP: buyers have already been given or used these passwords.");
  console.error("Rotating now locks them out with no warning. Re-issue deliberately instead.");
  // --force exists for dev, where the only buyer logins are QA ones this repo
  // made itself. It is never the right flag on production without first
  // deciding how the affected buyers get told.
  if (!FORCE) process.exit(1);
  console.error("--force given: continuing anyway.\n");
}

const { data: buyers } = await admin
  .from("buyers").select("id, business_name, email, encrypted_password").not("email", "is", null).order("business_name").range(0, 9999);
console.log(`buyers to rotate: ${buyers.length}`);
if (DRY) {
  console.log("\nsample of what would be issued:");
  buyers.slice(0, 5).forEach((b) => console.log(`  ${(b.business_name ?? "").padEnd(38)} ${b.email.split("@")[0].padEnd(22)} ${generateBuyerPassword()}`));
  console.log("\n--dry-run — nothing written.");
  process.exit(0);
}

const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const authByEmail = new Map((page?.users ?? []).map((u) => [(u.email || "").toLowerCase(), u]));

let done = 0; const failed = []; const issued = [];
for (const b of buyers) {
  const pw = generateBuyerPassword();
  const hit = authByEmail.get(b.email.toLowerCase());
  if (!hit) { failed.push(`${b.business_name} <${b.email}> — no auth user`); continue; }
  const { error: aErr } = await admin.auth.admin.updateUserById(hit.id, { password: pw, email_confirm: true });
  // GoTrue first: if it fails the stored ciphertext is left alone, so the row
  // keeps describing a password that still works.
  if (aErr) { failed.push(`${b.business_name} — auth: ${aErr.message}`); continue; }
  const { error: bErr } = await admin.from("buyers").update({ encrypted_password: encryptPassword(pw) }).eq("id", b.id);
  if (bErr) { failed.push(`${b.business_name} — db: ${bErr.message}`); continue; }
  await admin.from("auth_audit_log").insert({ buyer_id: b.id, event_type: "credential_created", notes: "bulk rotation onto the memorable scheme" });
  issued.push({ business: b.business_name, login: b.email.split("@")[0], password: pw });
  done++;
  if (done % 25 === 0) process.stdout.write(`  ${done}/${buyers.length}\n`);
}

fs.mkdirSync("backups", { recursive: true });
const f = `backups/rotated-logins-${PROD ? "prod" : "dev"}.json`;
fs.writeFileSync(f, JSON.stringify(issued, null, 1));
console.log(`\nrotated ${done}/${buyers.length} · written to ${f} (gitignored)`);
if (failed.length) { console.log(`FAILED ${failed.length}:`); failed.forEach((x) => console.log(`   ${x}`)); }
