/**
 * Point Shopify's order webhooks at the wallet's receiver.
 *
 *   node scripts/wallet-register-webhooks.mjs --url https://<portal-host>/api/wallet/webhooks/shopify
 *   node scripts/wallet-register-webhooks.mjs --list
 *
 * Idempotent: an existing subscription for the same topic+URL is left alone.
 * Uses the wallet's app (WALLET_SHOPIFY_CLIENT_ID/SECRET), because Shopify
 * signs deliveries with the SUBSCRIBING app's secret and the receiver
 * verifies against that same variable. Registering with a different app
 * would make every delivery fail its HMAC check.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development.local", override: true });

const TOPICS = ["ORDERS_CREATE", "ORDERS_PAID", "ORDERS_FULFILLED", "ORDERS_CANCELLED", "REFUNDS_CREATE"];
const argv = process.argv.slice(2);
const url = argv[argv.indexOf("--url") + 1];
const list = argv.includes("--list");

async function token() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.WALLET_SHOPIFY_CLIENT_ID || process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.WALLET_SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_CLIENT_SECRET,
  });
  const res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, { method: "POST", body });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}
async function gql(t, query, variables = {}) {
  const res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: "POST", headers: { "X-Shopify-Access-Token": t, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function main() {
  const t = await token();
  const d = await gql(t, `{ webhookSubscriptions(first:50){ nodes{ id topic endpoint{ ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  const existing = d.webhookSubscriptions.nodes;
  console.log("existing subscriptions on this app:");
  for (const s of existing) console.log(`   ${s.topic.padEnd(18)} ${s.endpoint?.callbackUrl ?? "(non-http)"}`);
  if (list || !url) { if (!url && !list) console.log("\nPass --url https://.../api/wallet/webhooks/shopify to register."); return; }

  for (const topic of TOPICS) {
    if (existing.some((s) => s.topic === topic && s.endpoint?.callbackUrl === url)) { console.log(`= ${topic} already -> ${url}`); continue; }
    const r = await gql(t, `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!){
      webhookSubscriptionCreate(topic:$topic, webhookSubscription:$sub){ webhookSubscription{ id } userErrors{ field message } } }`,
      { topic, sub: { callbackUrl: url, format: "JSON" } });
    const ue = r.webhookSubscriptionCreate.userErrors;
    console.log(ue.length ? `! ${topic}: ${ue.map((e) => e.message).join("; ")}` : `+ ${topic} -> ${url}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
