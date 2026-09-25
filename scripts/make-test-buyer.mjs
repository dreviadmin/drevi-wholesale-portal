/**
 * Create (or refresh) a clearly-marked QA buyer for end-to-end testing.
 *
 *   node scripts/make-test-buyer.mjs [--prod]
 *
 * Deliberately has NO phone. Every bulk WhatsApp path in this portal filters on
 * a phone being present, so a phoneless buyer cannot be swept into a credential
 * blast by accident — which matters because this row lives in the same buyers
 * table as 165 real shops.
 */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const masterKey = Buffer.from(process.env.PORTAL_PASSWORD_MASTER_KEY, "base64");
const admin = createClient(url, key, { auth: { persistSession: false } });

const NAME = "ZZ QA Test Shop (safe to delete)";
const USERNAME = "zzqatest";
const PASSWORD = "zzqatestxdrevi";
const EMAIL = `${USERNAME}@buyers.drevifashion.com`;

function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

const { data: existing } = await admin.from("buyers").select("id").eq("email", EMAIL).maybeSingle();
let buyerId = existing?.id;
if (!buyerId) {
  const { data, error } = await admin.from("buyers").insert({
    business_name: NAME, email: EMAIL, phone: null, status: "active",
    source: "exhibition", import_batch: "qa_test", notes: "End-to-end test account. No phone, so bulk WhatsApp sends skip it.",
  }).select("id").single();
  if (error) { console.error(`insert: ${error.message}`); process.exit(1); }
  buyerId = data.id;
  console.log("created buyer row");
} else console.log("buyer row already existed");

const { data: created, error: cErr } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
if (cErr && !/already/i.test(cErr.message)) { console.error(`auth: ${cErr.message}`); process.exit(1); }
if (!created?.user?.id) {
  const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const hit = (page?.users ?? []).find((u) => (u.email || "").toLowerCase() === EMAIL);
  if (hit) await admin.auth.admin.updateUserById(hit.id, { password: PASSWORD, email_confirm: true });
  console.log("auth user refreshed");
} else console.log("auth user created");

await admin.from("buyers").update({ encrypted_password: encryptPassword(PASSWORD), status: "active" }).eq("id", buyerId);

console.log(`\nTARGET:   ${PROD ? "PRODUCTION" : "dev"}`);
console.log(`buyer_id: ${buyerId}`);
console.log(`login:    ${USERNAME}`);
console.log(`password: ${PASSWORD}`);
