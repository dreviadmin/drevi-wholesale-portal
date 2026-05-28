/**
 * Phase 2 verification fixtures (TEMPORARY). The synced sheet data is all
 * "Limited Edition", so this flags a few products into the other stock states
 * and adds an MOQ, to exercise every quantity rule. Also creates a 2nd active
 * buyer for the RLS isolation check.
 *
 * Re-run `curl /api/dev/sync-now` afterwards to reset products to sheet truth.
 *
 *   node scripts/p2-fixtures.mjs
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 0) carts table reachable?
{
  const { error } = await admin.from("carts").select("buyer_id", { head: true, count: "exact" });
  console.log("carts table:", error ? `*** MISSING (${error.message}) ***` : "ok");
  if (error) process.exit(1);
}

// 1) pick 4 visible products to turn into fixtures
const { data: prods } = await admin
  .from("wholesale_products")
  .select("sku, title, current_qty")
  .eq("wholesale_visible", true)
  .order("sku")
  .limit(4);

const [readyMoq, mto, sold, limited] = prods;

await admin.from("wholesale_products").update({ restockable: true, current_qty: 10, restock_days: null, min_order_qty: 5 }).eq("sku", readyMoq.sku);
await admin.from("wholesale_products").update({ restockable: true, current_qty: 0, restock_days: 14, min_order_qty: null }).eq("sku", mto.sku);
await admin.from("wholesale_products").update({ restockable: false, current_qty: 0, restock_days: null, min_order_qty: null }).eq("sku", sold.sku);
// `limited` keeps its synced state (qty>0, restockable false) for the cap test.

console.log("\nFixtures set:");
console.log(`  IN STOCK + MOQ 5 : ${readyMoq.sku}  "${(readyMoq.title || "").slice(0, 30)}"`);
console.log(`  MADE TO ORDER 14d: ${mto.sku}  "${(mto.title || "").slice(0, 30)}"`);
console.log(`  SOLD OUT         : ${sold.sku}  "${(sold.title || "").slice(0, 30)}"`);
console.log(`  LIMITED (cap ${limited.current_qty}) : ${limited.sku}  "${(limited.title || "").slice(0, 30)}"`);

// 2) second active buyer for RLS isolation
async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const f = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (f) return f;
    if (data.users.length < 200) break;
  }
  return null;
}
const email2 = "buyer2@example.com";
const pw2 = "Jasmine-River-5521";
let u = await findUserByEmail(email2);
if (u) await admin.auth.admin.updateUserById(u.id, { password: pw2, email_confirm: true });
else await admin.auth.admin.createUser({ email: email2, password: pw2, email_confirm: true });
await admin.from("buyers").upsert({ email: email2, business_name: "Verma Designs", owner_name: "Anita Verma", phone: "+919800011122", city: "Delhi", status: "active", source: "manual_admin", approved_at: new Date().toISOString() }, { onConflict: "email" });
console.log(`\n2nd buyer: ${email2} / ${pw2} (Verma Designs, active)`);
