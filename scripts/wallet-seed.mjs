/**
 * Open a wallet, with its ₹1,000 welcome, for every Shopify customer that has
 * a phone number. Decided 26 Sep: everyone.
 *
 *   node scripts/wallet-seed.mjs                 dry run against DEV: counts and a sample, writes nothing
 *   node scripts/wallet-seed.mjs --apply         create the wallets in DEV
 *   node scripts/wallet-seed.mjs --apply --prod  create them in PROD (asks you to type the store name)
 *   node scripts/wallet-seed.mjs --send          also send the welcome on WhatsApp (needs WALLET_WA_LIVE=true)
 *
 * Safe to re-run: a phone that already has a wallet is skipped, and the
 * welcome credit is idempotent in the database (one 'welcome' per phone).
 *
 * Target selection copies apply-migration.mjs: dev is the default, prod needs
 * --prod. Shopify is the same store either way, read with the wallet's app
 * (WALLET_SHOPIFY_CLIENT_ID/SECRET, falling back to SHOPIFY_*).
 */
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const args = new Set(process.argv.slice(2));
const target = args.has("--prod") ? "prod" : "dev";
const envFile = target === "prod" ? ".env.local" : ".env.development.local";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: envFile, override: true });
const APPLY = args.has("--apply");
const SEND = args.has("--send");

const WELCOME_PAISE = Number(process.env.WALLET_WELCOME_PAISE ?? 100000);
const EXPIRY_MONTHS = Number(process.env.WALLET_EXPIRY_MONTHS ?? 12);

// Same rule as src/lib/wallet-core.ts normalizePhone — kept in sync by hand
// because this script runs outside the Next build.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  if (d.length === 12 && d.startsWith("91")) return /^91[6-9]\d{9}$/.test(d) ? d : null;
  if (d.length >= 11 && d.length <= 15 && !d.startsWith("0")) return d;
  return null;
}

async function shopifyToken() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.WALLET_SHOPIFY_CLIENT_ID || process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.WALLET_SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET,
  });
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, { method: "POST", body });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function gql(token, query, variables = {}) {
  const res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function allCustomers(token) {
  const out = [];
  let cursor = null;
  for (;;) {
    const d = await gql(token, `query($c:String){ customers(first:250, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ id phone firstName lastName displayName tags } } }`, { c: cursor });
    out.push(...d.customers.nodes);
    if (!d.customers.pageInfo.hasNextPage) break;
    cursor = d.customers.pageInfo.endCursor;
  }
  return out;
}

async function sendWelcome(phone, name, balancePaise) {
  if ((process.env.WALLET_WA_LIVE ?? "").toLowerCase() !== "true") return { dryRun: true };
  const res = await fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: process.env.AISENSY_CAMPAIGN_WELCOME || "drevi_wallet_welcome",
      destination: "+" + phone,
      userName: name || "there",
      source: "drevi-wallet-seed",
      templateParams: [name || "there", "₹" + Math.floor(balancePaise / 100).toLocaleString("en-IN")],
      tags: ["wallet", "welcome", "seed"],
    }),
  });
  return { sent: res.ok, status: res.status };
}

async function main() {
  console.log(`Target: ${target.toUpperCase()} (${envFile})  mode: ${APPLY ? "APPLY" : "DRY RUN"}${SEND ? " + SEND" : ""}`);
  if (APPLY && target === "prod") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("This opens wallets with real credit on the LIVE database. Type the store name to continue: ");
    rl.close();
    if (ans.trim().toLowerCase() !== "drevi fashion") { console.log("Aborted."); process.exit(1); }
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const token = await shopifyToken();
  const customers = await allCustomers(token);

  const byPhone = new Map();
  let noPhone = 0, badPhone = 0, dupes = 0;
  for (const c of customers) {
    if (!c.phone) { noPhone++; continue; }
    const p = normalizePhone(c.phone);
    if (!p) { badPhone++; console.warn(`  unusable phone on ${c.displayName}: ${c.phone}`); continue; }
    if (byPhone.has(p)) { dupes++; continue; }
    byPhone.set(p, { customerId: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.displayName || null });
  }

  const { data: existing } = await supabase.from("wallet_accounts").select("phone").in("phone", [...byPhone.keys()]);
  const have = new Set((existing ?? []).map((r) => r.phone));
  const todo = [...byPhone.entries()].filter(([p]) => !have.has(p));

  console.log(`\nShopify customers: ${customers.length}`);
  console.log(`  with a usable phone : ${byPhone.size}  (no phone ${noPhone}, unusable ${badPhone}, duplicate ${dupes})`);
  console.log(`  already have wallet : ${have.size}`);
  console.log(`  to open now         : ${todo.length}  x ₹${WELCOME_PAISE / 100} = ₹${((todo.length * WELCOME_PAISE) / 100).toLocaleString("en-IN")} of credit`);
  console.log(`  sample: ${todo.slice(0, 5).map(([p, v]) => `${v.name ?? "?"} (+${p})`).join(", ")}`);

  if (!APPLY) { console.log("\nDry run — nothing written. Add --apply to create them."); return; }

  let created = 0, credited = 0, sent = 0, failed = 0;
  for (const [phone, v] of todo) {
    const { data: acc, error } = await supabase
      .from("wallet_accounts")
      .insert({ phone, name: v.name, shopify_customer_id: v.customerId, source: "seed" })
      .select("id, balance_paise")
      .single();
    if (error) { failed++; console.error(`  ${phone}: ${error.message}`); continue; }
    created++;
    const { data: row, error: e2 } = await supabase.rpc("wallet_post_movement", {
      p_account: acc.id, p_kind: "welcome", p_amount: WELCOME_PAISE, p_ref_type: "seed", p_ref_id: phone,
      p_note: "Welcome to the Drevi Wallet", p_clamp: false, p_expiry_months: EXPIRY_MONTHS,
    });
    if (e2) { failed++; console.error(`  ${phone}: welcome failed: ${e2.message}`); continue; }
    if (row) credited++;
    if (SEND) {
      const r = await sendWelcome(phone, v.name, WELCOME_PAISE);
      if (r.sent) sent++;
      else if (!r.dryRun) console.warn(`  ${phone}: WhatsApp ${r.status}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.log(`\ncreated ${created} wallet(s), credited ${credited}, WhatsApp sent ${sent}, failed ${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
