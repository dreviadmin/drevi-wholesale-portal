// One-off repair for two gaps in the 21 Sep visiting-card import.
//
//  A. Asopan — buyers.phone was taken from contact 1 (Vijay Pajwani, whose
//     card number is a truncated 7-digit landline) instead of the first
//     AVAILABLE mobile, so the working number on contact 2 never reached the
//     buyer row. The script is fixed; this repairs the one row it cost.
//  B. Three brands whose card carries ONLY a landline. normPhone drops
//     landlines on purpose (buyers.phone drives wa.me links), so those numbers
//     ended up nowhere in the portal at all. They belong on buyer_contacts,
//     which renders a tel: link and is never used for WhatsApp.
//
// Idempotent: re-running changes nothing.
import { createClient } from "@supabase/supabase-js";

const WRITE = process.argv.includes("--write");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const PROMOTE = [{ business: "Asopan", phone: "+916354160700", why: "contact 2 (Jay Pajwani)" }];

const LANDLINES = [
  { business: "Ganpati Sarees",                 rows: [{ phone: "+912026111675", raw: "(020) 26111675" }] },
  { business: "Marwari Vastra (मारवाड़ी वस्त्र)", rows: [{ phone: "+911140592393", raw: "011-40592393" }] },
  { business: "Fashion Queen Private Limited",  rows: [
      { phone: "+912262377917", raw: "+91-22-62377917" },
      { phone: "+912262377918", raw: "+91-22-62377918" },
      { phone: "+912224318834", raw: "+91-22-24318834" },
  ] },
];

const { data: buyers, error } = await admin.from("buyers").select("id, business_name, phone").range(0, 999);
if (error) { console.error("read failed:", error.message); process.exit(1); }
const find = (name) => buyers.find((b) => b.business_name === name);

console.log(WRITE ? "=== WRITING ===" : "=== DRY RUN (pass --write to apply) ===");

for (const p of PROMOTE) {
  const b = find(p.business);
  if (!b) { console.log(`  ? ${p.business}: not on this database — skipped`); continue; }
  if (b.phone) { console.log(`  = ${p.business}: already has ${b.phone} — nothing to do`); continue; }
  console.log(`  + ${p.business}: buyers.phone := ${p.phone}  (from ${p.why})`);
  if (WRITE) {
    const { error: e } = await admin.from("buyers").update({ phone: p.phone }).eq("id", b.id).is("phone", null);
    if (e) console.error(`    ! ${e.message}`);
  }
}

for (const grp of LANDLINES) {
  const b = find(grp.business);
  if (!b) { console.log(`  ? ${grp.business}: not on this database — skipped`); continue; }
  // Partial unique index -> read then insert; ON CONFLICT cannot target it.
  const { data: have } = await admin.from("buyer_contacts").select("phone, position").eq("buyer_id", b.id);
  const seen = new Set((have ?? []).map((c) => c.phone).filter(Boolean));
  let pos = Math.max(3, ...(have ?? []).map((c) => c.position ?? 0)) + 1;
  for (const r of grp.rows) {
    if (seen.has(r.phone)) { console.log(`  = ${grp.business}: ${r.phone} already on file`); continue; }
    console.log(`  + ${grp.business}: buyer_contacts += ${r.phone}  (card: ${r.raw})`);
    if (WRITE) {
      const { error: e } = await admin.from("buyer_contacts").insert({
        buyer_id: b.id, first_name: null, last_name: null,
        designation: "Office (landline)", phone: r.phone,
        is_primary: false, position: pos, source: "visiting_card",
        notes: `Landline as printed: ${r.raw}. Not a WhatsApp number.`,
      });
      if (e) console.error(`    ! ${e.message}`);
    }
    pos++;
  }
}
console.log("done.");
