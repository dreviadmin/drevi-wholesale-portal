import { NextResponse } from "next/server";

import { verifyWebhookHmac } from "@/lib/wallet-shopify";
import { onOrderCancelled, onOrderCreated, onOrderPaidOrFulfilled, onRefund, recordWebhookOnce } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One receiver for the five order topics the wallet cares about. Shopify
// signs each delivery with the subscribing app's secret and retries anything
// that doesn't get a 2xx quickly, so: verify, record the delivery id, answer
// 200, and do the work — twice-delivered events are no-ops because the ledger
// is idempotent on (kind, order) and the delivery id is stored.
//
// Registered by scripts/wallet-register-webhooks.mjs against this URL.

const TOPICS = new Set(["orders/create", "orders/paid", "orders/fulfilled", "orders/cancelled", "refunds/create"]);

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ ok: false, error: "bad hmac" }, { status: 401 });
  }
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const deliveryId = req.headers.get("x-shopify-webhook-id") ?? `${topic}:${Date.now()}`;
  if (!TOPICS.has(topic)) return NextResponse.json({ ok: true, ignored: topic });

  let payload: { id?: number | string; admin_graphql_api_id?: string; order_id?: number | string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const orderId = topic === "refunds/create"
    ? (payload.order_id != null ? `gid://shopify/Order/${payload.order_id}` : null)
    : (payload.admin_graphql_api_id ?? (payload.id != null ? `gid://shopify/Order/${payload.id}` : null));
  if (!orderId) return NextResponse.json({ ok: false, error: "no order id" }, { status: 400 });

  const fresh = await recordWebhookOnce(deliveryId, topic, orderId);
  if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

  let result = "";
  try {
    switch (topic) {
      case "orders/create": result = await onOrderCreated(orderId); break;
      case "orders/paid":
      case "orders/fulfilled": result = await onOrderPaidOrFulfilled(orderId); break;
      case "orders/cancelled": result = await onOrderCancelled(orderId); break;
      case "refunds/create": result = await onRefund(orderId, payload.admin_graphql_api_id ?? String(payload.id)); break;
    }
  } catch (e) {
    // Log and still 200: a 5xx makes Shopify retry for days, and the ledger's
    // idempotency means a human can replay safely once the cause is fixed.
    console.error(`[wallet-webhook] ${topic} ${orderId}:`, (e as Error).message);
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) });
  }
  console.info(`[wallet-webhook] ${topic} ${orderId}: ${result}`);
  return NextResponse.json({ ok: true, result });
}
