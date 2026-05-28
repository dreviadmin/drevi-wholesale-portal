import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: b1 } = await admin.from("buyers").select("id").eq("email", "buyer@example.com").maybeSingle();

// latest order for buyer1
const { data: order } = await admin.from("orders").select("*").eq("buyer_id", b1.id).order("submitted_at", { ascending: false }).limit(1).maybeSingle();
console.log("=== latest order (buyer1) ===");
console.log(JSON.stringify({
  order_number: order.order_number, status: order.status, source: order.source,
  total_amount: order.total_amount, notes: order.notes,
  items: order.items.map(i => ({ sku: i.sku, qty: i.qty, unit_price: i.unit_price, stock_state: i.stock_state, restock_days: i.restock_days })),
}, null, 2));

// cart cleared?
const { data: cart } = await admin.from("carts").select("items").eq("buyer_id", b1.id).maybeSingle();
console.log("\ncart after submit:", (cart?.items ?? []).length, "items (expect 0)");

// RLS: buyer1 sees own orders; buyer2 sees none of buyer1's
async function ordersAs(email, pw) {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: pw });
  if (error) return `login failed: ${error.message}`;
  const { data } = await c.from("orders").select("id, order_number, buyer_id");
  await c.auth.signOut();
  return data;
}
const o1 = await ordersAs("buyer@example.com", "Tulip-Lotus-7382");
const o2 = await ordersAs("buyer2@example.com", "Jasmine-River-5521");
console.log("\n=== RLS ===");
console.log("buyer1 sees orders:", Array.isArray(o1) ? o1.length : o1, Array.isArray(o1) ? o1.map(o=>o.order_number) : "");
console.log("buyer2 sees orders:", Array.isArray(o2) ? o2.length : o2, "(expect 0 — cannot see buyer1's)");
console.log("buyer2 sees buyer1's order id?", Array.isArray(o2) ? o2.some(o => o.buyer_id === b1.id) : "n/a", "(expect false)");
