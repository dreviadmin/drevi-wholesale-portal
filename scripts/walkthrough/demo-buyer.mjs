/**
 * The identity the walkthrough is filmed as — and its complete removal.
 *
 *   node scripts/walkthrough/demo-buyer.mjs create
 *   node scripts/walkthrough/demo-buyer.mjs destroy
 *
 * Filmed on PRODUCTION so the catalogue in the video is the real one (dev has
 * 16 visible products; prod has the full range). "Royal Sarees", login
 * `royal`, matches the WhatsApp mock-up in the opening scene.
 *
 * destroy removes everything the filming created, in FK order: the demo
 * order's PDF and row, audit rows, contacts, the auth user, then the buyer.
 * buyers is referenced by nine tables; the cascading ones (carts, notify_me,
 * buyer_contacts, buyer_change_requests, buyer_agents) go with the row, the
 * non-cascading ones (orders, auth_audit_log) are removed here explicitly.
 */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { generateMemorablePassword } from "../lib/password.mjs";

dotenv.config({ path: ".env.local", override: true });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const masterKey = Buffer.from(process.env.PORTAL_PASSWORD_MASTER_KEY, "base64");

export const DEMO = { name: "Royal Sarees", city: "Surat", username: "royal", email: "royal@buyers.drevifashion.com", batch: "walkthrough_demo" };

function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

async function findAuth(email) {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  return (data?.users ?? []).find((u) => (u.email || "").toLowerCase() === email.toLowerCase()) ?? null;
}

const mode = process.argv[2];
if (mode === "create") {
  const { data: clash } = await admin.from("buyers").select("id, business_name").eq("email", DEMO.email).maybeSingle();
  if (clash && clash.business_name !== DEMO.name) { console.error(`login "${DEMO.username}" already belongs to ${clash.business_name} — refusing`); process.exit(1); }
  const password = generateMemorablePassword();
  let id = clash?.id;
  if (!id) {
    const { data, error } = await admin.from("buyers").insert({
      business_name: DEMO.name, city: DEMO.city, email: DEMO.email, phone: null, status: "active",
      source: "exhibition", import_batch: DEMO.batch, notes: "Walkthrough video demo identity. Removed by demo-buyer.mjs destroy.",
    }).select("id").single();
    if (error) { console.error(error.message); process.exit(1); }
    id = data.id;
  }
  const existing = await findAuth(DEMO.email);
  if (existing) await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
  else { const { error } = await admin.auth.admin.createUser({ email: DEMO.email, password, email_confirm: true }); if (error) { console.error(error.message); process.exit(1); } }
  await admin.from("buyers").update({ encrypted_password: encryptPassword(password) }).eq("id", id);
  console.log(JSON.stringify({ id, username: DEMO.username, password }));
} else if (mode === "destroy") {
  const { data: b } = await admin.from("buyers").select("id").eq("email", DEMO.email).maybeSingle();
  if (!b) { console.log("no demo buyer present"); process.exit(0); }
  const { data: orders } = await admin.from("orders").select("id, order_number").eq("buyer_id", b.id);
  for (const o of orders ?? []) {
    const { data: files } = await admin.storage.from("order-pdfs").list(o.id);
    if (files?.length) await admin.storage.from("order-pdfs").remove(files.map((f) => `${o.id}/${f.name}`));
    await admin.from("orders").delete().eq("id", o.id);
    console.log(`removed order ${o.order_number}`);
  }
  const { count: au } = await admin.from("auth_audit_log").delete({ count: "exact" }).eq("buyer_id", b.id);
  const { count: ct } = await admin.from("buyer_contacts").delete({ count: "exact" }).eq("buyer_id", b.id);
  const user = await findAuth(DEMO.email);
  if (user) await admin.auth.admin.deleteUser(user.id);
  const { error } = await admin.from("buyers").delete().eq("id", b.id);
  if (error) { console.error(`buyer delete: ${error.message}`); process.exit(1); }
  const { data: chk } = await admin.from("buyers").select("id").eq("email", DEMO.email);
  console.log(`removed: audit ${au ?? 0}, contacts ${ct ?? 0}, auth user ${user ? "yes" : "n/a"}, buyer row ${chk.length === 0 ? "yes" : "STILL PRESENT"}`);
} else {
  console.error("usage: create | destroy"); process.exit(1);
}
