/**
 * Read-only look at the wallet tables — accounts, the last ledger rows, open
 * redemptions, recent webhook deliveries. Prod by default (it reads
 * .env.local); pass --dev to look at the dev database.
 *
 *   node scripts/wallet-status.mjs            all recent activity
 *   node scripts/wallet-status.mjs 9876543210 one phone, with its statement
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
const args = process.argv.slice(2);
dotenv.config({ path: args.includes("--dev") ? ".env.development.local" : ".env.local" });
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const rs = (p) => "₹" + (Math.floor(Math.abs(p) / 100)).toLocaleString("en-IN") + (p < 0 ? " (debit)" : "");
const phoneArg = args.find((a) => /^\d{10,15}$/.test(a));
const phone = phoneArg ? (phoneArg.length === 10 ? "91" + phoneArg : phoneArg) : null;

const { count: nAcc } = await s.from("wallet_accounts").select("*", { count: "exact", head: true });
const { data: sums } = await s.from("wallet_accounts").select("balance_paise");
const total = (sums ?? []).reduce((a, r) => a + r.balance_paise, 0);
console.log(`wallets: ${nAcc ?? 0}   total balance: ${rs(total)}   (${args.includes("--dev") ? "DEV" : "PROD"})`);

let q = s.from("wallet_accounts").select("id, phone, name, balance_paise, expires_at, source, shopify_customer_id, created_at").order("created_at", { ascending: false }).limit(10);
if (phone) q = q.eq("phone", phone);
const { data: accs } = await q;
for (const a of accs ?? []) {
  console.log(`\n+${a.phone}  ${a.name ?? "—"}  balance ${rs(a.balance_paise)}  expires ${a.expires_at?.slice(0, 10) ?? "—"}  via ${a.source}  customer ${a.shopify_customer_id ? "linked" : "not linked"}`);
  const { data: led } = await s.from("wallet_ledger").select("kind, amount_paise, balance_after_paise, ref_type, ref_id, note, created_at").eq("account_id", a.id).order("created_at", { ascending: false }).limit(phone ? 50 : 5);
  for (const l of led ?? []) console.log(`   ${l.created_at.slice(11, 19)}  ${l.kind.padEnd(15)} ${(l.amount_paise > 0 ? "+" : "−") + rs(Math.abs(l.amount_paise)).padEnd(9)} → ${rs(l.balance_after_paise).padEnd(8)} ${l.note ?? ""} ${l.ref_id ? "[" + l.ref_id.split("/").pop() + "]" : ""}`);
  const { data: red } = await s.from("wallet_redemptions").select("code, amount_paise, status, expires_at, shopify_order_id").eq("account_id", a.id).order("created_at", { ascending: false }).limit(5);
  for (const r of red ?? []) console.log(`   code ${r.code}  ${rs(r.amount_paise)}  ${r.status}${r.shopify_order_id ? "  order " + r.shopify_order_id.split("/").pop() : ""}`);
}
const { data: wh } = await s.from("wallet_webhook_events").select("topic, shopify_order_id, received_at").order("received_at", { ascending: false }).limit(10);
console.log(`\nwebhook deliveries received: ${(wh ?? []).length ? "" : "none yet"}`);
for (const w of wh ?? []) console.log(`   ${w.received_at.slice(0, 19)}  ${w.topic.padEnd(18)} order ${w.shopify_order_id?.split("/").pop() ?? "—"}`);
const { count: nOtp } = await s.from("wallet_otps").select("*", { count: "exact", head: true });
console.log(`otp codes issued so far: ${nOtp ?? 0}`);
