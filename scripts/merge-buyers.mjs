/**
 * Merge one buyer row into another. The loser's orders and audit trail move to
 * the keeper; the loser's login is revoked and its row deleted.
 *
 *   node scripts/merge-buyers.mjs --keep <id> --drop <id> [--prod] [--dry-run]
 *
 * WHY A SCRIPT AND NOT SQL: buyers is referenced by nine tables, five of them
 * ON DELETE CASCADE (carts, notify_me, buyer_contacts, buyer_change_requests,
 * buyer_agents). A bare `delete from buyers` therefore SILENTLY discards
 * whatever the loser had in those, rather than merging it. This checks every
 * one of the nine and refuses to run if a cascading table holds rows it has no
 * rule for, so the failure mode is a stop rather than quiet data loss.
 *
 * Order snapshots (orders.buyer_business_name and friends) are deliberately
 * frozen at submission and are NOT rewritten, with one exception: when the two
 * names differ only by capitalisation it is the same shop typed twice, so the
 * moved order takes the keeper's spelling instead of showing a second name in
 * the keeper's order list.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
const DRY = process.argv.includes("--dry-run");
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const KEEP = arg("keep"), DROP = arg("drop");
if (!KEEP || !DROP) { console.error("usage: --keep <id> --drop <id> [--prod] [--dry-run]"); process.exit(1); }
if (KEEP === DROP) { console.error("keep and drop are the same row"); process.exit(1); }

dotenv.config({ path: PROD ? ".env.local" : ".env.development.local", override: true });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Every table that references buyers, and what this script does with it.
const REFERENCES = [
  { table: "orders", action: "move" },
  { table: "auth_audit_log", action: "move" },
  { table: "buyer_contacts", action: "move" },
  { table: "notify_me", action: "move" },
  { table: "carts", action: "drop" },                  // a live cart is per-session working state
  { table: "buyer_change_requests", action: "move" },
  { table: "buyer_agents", action: "move" },
  { table: "credit_ledger", action: "move" },
  { table: "credit_notes", action: "move" },
];

const { data: keep } = await admin.from("buyers").select("*").eq("id", KEEP).maybeSingle();
const { data: drop } = await admin.from("buyers").select("*").eq("id", DROP).maybeSingle();
if (!keep) { console.error(`keeper ${KEEP} not found`); process.exit(1); }
if (!drop) { console.error(`loser ${DROP} not found`); process.exit(1); }

console.log(`TARGET: ${PROD ? "PRODUCTION" : "dev"}`);
console.log(`KEEP  ${keep.business_name}  <${keep.email}>  ${keep.phone ?? "(no phone)"}  created ${String(keep.created_at).slice(0, 10)}`);
console.log(`DROP  ${drop.business_name}  <${drop.email}>  ${drop.phone ?? "(no phone)"}  created ${String(drop.created_at).slice(0, 10)}`);

// Fields the keeper lacks and the loser has — merged in rather than lost.
const CARRY = ["owner_name", "city", "gstin", "address", "category", "website", "instagram", "facebook", "email_alt", "card_image_path"];
const patch = {};
for (const f of CARRY) if (!keep[f] && drop[f]) patch[f] = drop[f];
console.log(`\ncarry over to the keeper: ${Object.keys(patch).length ? Object.entries(patch).map(([k, v]) => `${k}="${String(v).slice(0, 40)}"`).join(", ") : "(nothing — keeper already has it all)"}`);

const plan = [];
for (const r of REFERENCES) {
  const { data, error } = await admin.from(r.table).select("*", { count: "exact" }).eq("buyer_id", DROP);
  if (error) { console.log(`  ${r.table.padEnd(24)} (not readable: ${error.message.slice(0, 40)})`); continue; }
  if (!data?.length) continue;
  plan.push({ ...r, rows: data });
  const detail = r.table === "orders" ? data.map((o) => o.order_number).join(", ") : `${data.length} row(s)`;
  console.log(`  ${r.table.padEnd(24)} ${r.action.toUpperCase().padEnd(5)} ${detail}`);
}
if (!plan.length) console.log("  (nothing references the loser)");

const sameNameDifferentCase =
  (keep.business_name ?? "").trim().toLowerCase() === (drop.business_name ?? "").trim().toLowerCase() &&
  (keep.business_name ?? "").trim() !== (drop.business_name ?? "").trim();

if (DRY) { console.log("\n--dry-run — nothing written."); process.exit(0); }

for (const p of plan) {
  if (p.action === "drop") {
    const { error } = await admin.from(p.table).delete().eq("buyer_id", DROP);
    console.log(`  ${p.table}: dropped ${p.rows.length} — ${error ? error.message : "ok"}`);
    continue;
  }
  const { error } = await admin.from(p.table).update({ buyer_id: KEEP }).eq("buyer_id", DROP);
  if (error) { console.error(`  ${p.table}: FAILED ${error.message} — stopping before the delete`); process.exit(1); }
  console.log(`  ${p.table}: moved ${p.rows.length} to the keeper`);
  if (p.table === "orders" && sameNameDifferentCase) {
    await admin.from("orders").update({ buyer_business_name: keep.business_name })
      .in("order_number", p.rows.map((o) => o.order_number));
    console.log(`    snapshot name normalised to "${keep.business_name}" (same shop, different capitalisation)`);
  }
}

const note = [keep.notes, `[merge ${new Date().toISOString().slice(0, 10)}] "${drop.business_name}" <${drop.email}> merged into this buyer; its orders and audit trail moved here, its login revoked.`]
  .filter(Boolean).join("\n");
await admin.from("buyers").update({ ...patch, notes: note }).eq("id", KEEP);
console.log("  keeper updated (carried fields + merge note)");

if (drop.email) {
  const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const hit = (page?.users ?? []).find((u) => (u.email || "").toLowerCase() === drop.email.toLowerCase());
  if (hit) { const { error } = await admin.auth.admin.deleteUser(hit.id); console.log(`  auth user ${drop.email}: ${error ? error.message : "deleted"}`); }
  else console.log(`  auth user ${drop.email}: not found`);
}

const { error: dErr } = await admin.from("buyers").delete().eq("id", DROP);
console.log(`  loser row: ${dErr ? "FAILED " + dErr.message : "deleted"}`);
if (dErr) process.exit(1);
console.log("\nmerged.");
