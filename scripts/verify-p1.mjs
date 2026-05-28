/**
 * Phase 1 verification probe (read-only). Checks synced data, image cache,
 * the cached Shopify token, and performs a real buyer login + RLS-scoped reads.
 *
 *   node scripts/verify-p1.mjs
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

function stockState(p) {
  if (p.current_qty > 0 && p.restockable) return "ready";
  if (p.current_qty > 0 && !p.restockable) return "limited";
  if (p.current_qty <= 0 && p.restockable) return "made_to_order";
  return "sold_out";
}

async function main() {
  // --- products ---
  const { data: prods, error: pErr } = await admin
    .from("wholesale_products")
    .select("sku,title,current_qty,restockable,restock_days,wholesale_price,image_urls,images_fetched_at,wholesale_visible");
  if (pErr) throw pErr;
  const visible = prods.filter((p) => p.wholesale_visible);
  const withImages = prods.filter((p) => Array.isArray(p.image_urls) && p.image_urls.length > 0);
  const withFetchedAt = prods.filter((p) => p.images_fetched_at);
  const states = {};
  for (const p of visible) states[stockState(p)] = (states[stockState(p)] ?? 0) + 1;

  console.log("=== wholesale_products ===");
  console.log(`  total rows         : ${prods.length}`);
  console.log(`  wholesale_visible  : ${visible.length}`);
  console.log(`  with image_urls    : ${withImages.length}`);
  console.log(`  with images_fetched_at: ${withFetchedAt.length}`);
  console.log(`  stock states (visible): ${JSON.stringify(states)}`);
  console.log("  sample:");
  for (const p of visible.slice(0, 3)) {
    console.log(`    ${p.sku} | "${(p.title ?? "").slice(0, 28)}" | qty=${p.current_qty} | ${stockState(p)} | ₹${p.wholesale_price} | imgs=${(p.image_urls || []).length}`);
    if (p.image_urls?.[0]) console.log(`      img0: ${p.image_urls[0].slice(0, 80)}`);
  }

  // --- shopify token ---
  const { data: tok } = await admin.from("shopify_tokens").select("*").eq("id", "default").maybeSingle();
  console.log("\n=== shopify_tokens ===");
  if (tok) {
    const future = new Date(tok.expires_at).getTime() > Date.now();
    const hrs = ((new Date(tok.expires_at).getTime() - Date.now()) / 36e5).toFixed(1);
    console.log(`  token cached: yes (len ${tok.access_token.length}) | expires_at ${tok.expires_at} | future=${future} (${hrs}h left)`);
  } else {
    console.log("  *** no cached token ***");
  }

  // --- staff/buyers/audit ---
  const { count: staffCount } = await admin.from("staff_users").select("*", { count: "exact", head: true });
  const { data: buyer } = await admin.from("buyers").select("id,status,business_name").eq("email", "buyer@example.com").maybeSingle();
  const { count: auditCount } = await admin.from("auth_audit_log").select("*", { count: "exact", head: true });
  console.log("\n=== auth/state ===");
  console.log(`  staff_users: ${staffCount} | test buyer: ${buyer?.business_name} status=${buyer?.status} | audit rows: ${auditCount}`);

  // --- real buyer login + RLS ---
  const userClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: signin, error: sErr } = await userClient.auth.signInWithPassword({ email: "buyer@example.com", password: "Tulip-Lotus-7382" });
  console.log("\n=== buyer login + RLS ===");
  if (sErr) {
    console.log(`  *** login FAILED: ${sErr.message} ***`);
  } else {
    console.log(`  login OK (user ${signin.user.email})`);
    const { data: rlsProds } = await userClient.from("wholesale_products").select("sku").eq("wholesale_visible", true);
    const { data: ownBuyer } = await userClient.from("buyers").select("email,business_name");
    const { data: staffPeek } = await userClient.from("staff_users").select("email");
    console.log(`  RLS: buyer can read ${rlsProds?.length ?? 0} visible products`);
    console.log(`  RLS: buyer sees ${ownBuyer?.length ?? 0} buyer row(s) (own only) -> ${ownBuyer?.map((b) => b.email).join(",")}`);
    console.log(`  RLS: buyer sees ${staffPeek?.length ?? 0} staff row(s) (should be 0)`);
    await userClient.auth.signOut();
  }
}
main().catch((e) => { console.error("verify failed:", e.message); process.exit(1); });
