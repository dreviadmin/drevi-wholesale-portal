import { NextResponse } from "next/server";

import { verifyWebhookHmac } from "@/lib/wallet-shopify";
import { onOrderCancelled, onOrderCreated, onOrderPaidOrFulfilled, onRefund, recordWebhookOnce, webhookHandled } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One receiver for the five order topics the wallet cares about. Shopify
// signs each delivery with the subscribing app's secret and retries anything
// that doesn't get a 2xx within five seconds (8 retries over about 4 hours,
// per its docs), so: verify, skip a delivery id already handled, do the work,
// and only then record the delivery id. A handler that throws answers 500 and
// leaves the id unrecorded, so the retry runs it again. Running a handler
// twice — a retry after a partial run, or a redelivery overlapping a slow
// first run — is safe: every balance change goes through wallet_post_movement,
// which does nothing for a (kind, reference) it has already posted.
//
// Shopify drops a delivery that fails all its retries, and enough failures in
// a row make it remove the subscription, which would silence every wallet
// event. So a delivery still failing GIVE_UP_MS after Shopify first sent it
// is logged as "[wallet-webhook] GAVE UP" with what is needed to replay it by
// hand, and answered 200. If the subscription does go, re-run the
// registration script below.
//
// Registered by scripts/wallet-register-webhooks.mjs against this URL.

const GIVE_UP_MS = 3 * 60 * 60 * 1000; // Shopify's last retry comes about 4 hours in

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

  if (await webhookHandled(deliveryId)) return NextResponse.json({ ok: true, duplicate: true });

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
    const message = (e as Error).message;
    const sentAt = Date.parse(req.headers.get("x-shopify-triggered-at") ?? "");
    if (Number.isFinite(sentAt) && Date.now() - sentAt > GIVE_UP_MS) {
      console.error(`[wallet-webhook] GAVE UP ${topic} ${orderId} delivery ${deliveryId} after ${Math.round((Date.now() - sentAt) / 60000)} min — replay by hand:`, message);
      return NextResponse.json({ ok: false, gave_up: true, error: message.slice(0, 200) });
    }
    // 500 so Shopify retries. A 200 here lost the event for good: an
    // un-debited order kept its wallet discount, or an earning never came.
    console.error(`[wallet-webhook] ${topic} ${orderId}:`, message);
    return NextResponse.json({ ok: false, error: message.slice(0, 200) }, { status: 500 });
  }
  // The work is done, so a failure to record it is not worth a retry: a
  // redelivery would only find everything already posted.
  await recordWebhookOnce(deliveryId, topic, orderId)
    .catch((e) => console.warn(`[wallet-webhook] record ${deliveryId}:`, (e as Error).message));
  console.info(`[wallet-webhook] ${topic} ${orderId}: ${result}`);
  return NextResponse.json({ ok: true, result });
}
