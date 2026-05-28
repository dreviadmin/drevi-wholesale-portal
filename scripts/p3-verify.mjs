import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const key = Buffer.from(process.env.PORTAL_PASSWORD_MASTER_KEY, "base64");

function decrypt(b64) {
  const b = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

const EMAIL = process.argv[2] || "anjali@bloomco.test";
const EXPECT = process.argv[3] || "Amber-Cobalt-3453";

const { data: buyer } = await admin.from("buyers").select("id, status, encrypted_password, approved_by").eq("email", EMAIL).maybeSingle();
console.log("=== STEP 1: AES round-trip (set -> stored -> decrypt) ===");
console.log("  status:", buyer.status, "| has ciphertext:", !!buyer.encrypted_password);
const decrypted = buyer.encrypted_password ? decrypt(buyer.encrypted_password) : null;
console.log("  decrypted === expected:", decrypted === EXPECT, `(decrypted="${decrypted}")`);

console.log("\n=== STEP 5: buyer can log in ===");
const c = createClient(url, anon, { auth: { persistSession: false } });
const { data: si, error: se } = await c.auth.signInWithPassword({ email: EMAIL, password: EXPECT });
console.log("  login:", se ? `FAILED (${se.message})` : `OK (${si.user.email})`);
await c.auth.signOut({ scope: "local" });

console.log("\n=== STEP 3: audit trail ===");
const { data: staff } = await admin.from("staff_users").select("id,name").eq("email", "rakesh@drevifashion.com").maybeSingle();
const { data: events } = await admin.from("auth_audit_log").select("event_type, staff_user_id, notes").eq("buyer_id", buyer.id).order("event_at", { ascending: false });
console.log("  events:", events.map(e => e.event_type).join(", "));
const created = events.find(e => e.event_type === "credential_created");
console.log("  credential_created attributed to rakesh:", created?.staff_user_id === staff.id);
// no password values anywhere in audit notes (scan all)
const { data: allAudit } = await admin.from("auth_audit_log").select("notes");
const leak = (allAudit || []).some(e => e.notes && e.notes.includes(EXPECT));
console.log("  password value leaked into any audit notes:", leak, "(expect false)");
