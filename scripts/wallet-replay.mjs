/**
 * Re-send one Shopify order event to the wallet's webhook receiver, signed
 * the way Shopify signs it. For a delivery that GAVE UP (see docs/wallet.md):
 * once the cause is fixed, the receiver runs the same handler again. That is
 * safe to repeat: every balance change goes through wallet_post_movement,
 * which does nothing for a movement it has already posted, so a replay of an
 * event that did get through answers "already debited" / "already earned".
 *
 *   node scripts/wallet-replay.mjs --order '#1091' --topic orders/paid
 *   node scripts/wallet-replay.mjs --order gid://shopify/Order/123 --topic refunds/create --dry
 *   node scripts/wallet-replay.mjs --dev --order '#1091' --topic orders/create     (to http://localhost:3000)
 *
 *   --order   #name (quote it: the shell treats # as a comment), the order's
 *             gid, or its numeric id
 *   --topic   orders/create | orders/paid | orders/fulfilled | orders/cancelled | refunds/create
 *             (refunds/create sends one delivery per refund on the order)
 *   --url     receiver; default the prod receiver, or with --dev
 *             http://localhost:3000/api/wallet/webhooks/shopify
 *   --dry     print what would be sent, send nothing
 *   --dev     read .env.development.local instead of .env.local
 *   --env F   read env file F instead (a path); wins over --dev
 *
 * Needs SHOPIFY_STORE_DOMAIN, WALLET_SHOPIFY_CLIENT_ID and
 * WALLET_SHOPIFY_CLIENT_SECRET (the Drevi Admin Automation app, whose secret
 * the receiver checks signatures with). It reads orders from Shopify and
 * never writes there; the receiver does whatever the handler does.
 */
import { createHmac } from "node:crypto";
import dotenv from "dotenv";

const PROD_URL = "https://drevi-wholesale-portal-swart.vercel.app/api/wallet/webhooks/shopify";
const DEV_URL = "http://localhost:3000/api/wallet/webhooks/shopify";
const TOPICS = ["orders/create", "orders/paid", "orders/fulfilled", "orders/cancelled", "refunds/create"];
const API = "2026-01";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const dev = argv.includes("--dev");
const dry = argv.includes("--dry");
const envFile = opt("--env") ?? (dev ? ".env.development.local" : ".env.local");
const orderArg = opt("--order");
const topic = opt("--topic");
const url = opt("--url") ?? (dev ? DEV_URL : PROD_URL);

function die(msg) { console.error(msg); process.exit(1); }
if (!orderArg || !topic) die("usage: node scripts/wallet-replay.mjs --order <#name|gid|id> --topic <" + TOPICS.join("|") + "> [--url <receiver>] [--dry] [--dev] [--env <file>]");
if (!TOPICS.includes(topic)) die(`unknown --topic ${topic}; one of ${TOPICS.join(", ")}`);

dotenv.config({ path: envFile, quiet: true });
const domain = process.env.SHOPIFY_STORE_DOMAIN;
const clientId = process.env.WALLET_SHOPIFY_CLIENT_ID;
const secret = process.env.WALLET_SHOPIFY_CLIENT_SECRET;
// No fallback to SHOPIFY_CLIENT_*: that is the Drevi Pipeline app, and a body
// signed with its secret fails the receiver's check (401).
if (!domain || !clientId || !secret) die(`${envFile} has no SHOPIFY_STORE_DOMAIN / WALLET_SHOPIFY_CLIENT_ID / WALLET_SHOPIFY_CLIENT_SECRET. Pass --env <file that has them>.`);

async function token() {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
  });
  if (!res.ok) die(`Shopify token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function gql(tok, query, variables = {}) {
  const res = await fetch(`https://${domain}/admin/api/${API}/graphql.json`, {
    method: "POST", headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (!res.ok || j.errors) die(`Shopify: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  return j.data;
}

/** The order as {id, name, refunds}: by gid, by numeric id, or by its #name. */
async function resolveOrder(tok, arg) {
  const fields = "id name cancelledAt displayFinancialStatus displayFulfillmentStatus refunds { id createdAt }";
  const raw = String(arg).trim();
  if (raw.startsWith("gid://shopify/Order/") || /^\d{10,}$/.test(raw)) {
    const gid = raw.startsWith("gid://") ? raw : `gid://shopify/Order/${raw}`;
    const d = await gql(tok, `query($id:ID!){ order(id:$id){ ${fields} } }`, { id: gid });
    if (!d.order) die(`no order ${gid}`);
    return d.order;
  }
  const name = raw.startsWith("#") ? raw : `#${raw}`;
  const d = await gql(tok, `query($q:String!){ orders(first:5, query:$q){ nodes{ ${fields} } } }`, { q: `name:${JSON.stringify(name)}` });
  const hit = d.orders.nodes.find((o) => o.name === name);
  if (!hit) die(`no order named ${name}`);
  return hit;
}

const tail = (gid) => String(gid).split("/").pop();

const tok = await token();
const order = await resolveOrder(tok, orderArg);
console.log(`order ${order.name} (${order.id}): ${order.displayFinancialStatus ?? "?"} / ${order.displayFulfillmentStatus ?? "?"}${order.cancelledAt ? " / cancelled" : ""}`);

// The receiver reads admin_graphql_api_id for order topics; for a refund it
// reads order_id (numeric) and the refund's admin_graphql_api_id.
const deliveries = topic === "refunds/create"
  ? order.refunds.map((r) => ({ order_id: Number(tail(order.id)), admin_graphql_api_id: r.id }))
  : [{ id: Number(tail(order.id)), admin_graphql_api_id: order.id }];
if (!deliveries.length) die(`${order.name} has no refunds; nothing to send for refunds/create`);

console.log(`${dry ? "would send" : "sending"} ${deliveries.length} × ${topic} to ${url}`);
for (const payload of deliveries) {
  const body = JSON.stringify(payload);
  // A fresh delivery id, so the receiver doesn't skip it as handled. No
  // X-Shopify-Triggered-At: a replay is never old enough to "give up".
  const id = `replay-${topic.replace("/", "-")}-${tail(order.id)}-${Date.now()}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": topic,
    "X-Shopify-Webhook-Id": id,
    "X-Shopify-Shop-Domain": domain,
    "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64"),
  };
  if (dry) { console.log(`  ${id}  ${body}`); continue; }
  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  console.log(`  ${id}  HTTP ${res.status}  ${text.slice(0, 400)}`);
  if (!res.ok) process.exitCode = 1;
}
