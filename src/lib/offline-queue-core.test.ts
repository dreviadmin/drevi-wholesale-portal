import { describe, it, expect } from "vitest";
import { retryingCaptureRefs, unsyncedBuyerCountsAttempt, ordersWaitingOn } from "./offline-queue-core";
import type { CapturePayload, OrderPayload, QueueItem } from "./offline";

const capture = (id: number, clientRef: string, attempts = 0): QueueItem => ({
  id,
  type: "capture",
  payload: { clientRef, form: { business_name: "B", owner_name: "O", email: "", phone: "9", city: "Mumbai" } } as CapturePayload,
  attempts,
  createdAt: "2026-10-04T10:00:00Z",
});
const order = (id: number, over: Partial<OrderPayload> = {}, attempts = 0): QueueItem => ({
  id,
  type: "order",
  payload: { sessionId: "s", eventName: "e", items: [{ sku: "DD-X", qty: 1 }], ...over } as OrderPayload,
  attempts,
  createdAt: "2026-10-04T10:00:00Z",
});

describe("retryingCaptureRefs", () => {
  it("lists a capture that failed this drain and is still under the cap", () => {
    const r = retryingCaptureRefs([capture(1, "cap-a", 2)], new Map([[1, 3]]), 5);
    expect([...r]).toEqual(["cap-a"]);
  });
  it("drops a capture that just reached the cap", () => {
    expect(retryingCaptureRefs([capture(1, "cap-a", 4)], new Map([[1, 5]]), 5).size).toBe(0);
  });
  it("drops a capture that synced (or was skipped as capped) — it has no entry", () => {
    expect(retryingCaptureRefs([capture(1, "cap-a", 0), capture(2, "cap-b", 5)], new Map(), 5).size).toBe(0);
  });
});

describe("unsyncedBuyerCountsAttempt", () => {
  const retrying = new Set(["cap-a"]);
  it("does not spend an order attempt while its capture is still retrying", () => {
    expect(unsyncedBuyerCountsAttempt(order(9, { buyerClientRef: "cap-a" }).payload as OrderPayload, retrying)).toBe(false);
  });
  it("counts once the capture is capped or discarded, so the order can still reach Failed", () => {
    expect(unsyncedBuyerCountsAttempt(order(9, { buyerClientRef: "cap-gone" }).payload as OrderPayload, retrying)).toBe(true);
    expect(unsyncedBuyerCountsAttempt(order(9, { buyerClientRef: "cap-a" }).payload as OrderPayload, new Set())).toBe(true);
  });
  it("counts an order with no capture link at all", () => {
    expect(unsyncedBuyerCountsAttempt(order(9).payload as OrderPayload, retrying)).toBe(true);
  });
});

describe("ordersWaitingOn", () => {
  const queue = [
    capture(1, "cap-a", 5),
    order(10, { buyerClientRef: "cap-a" }, 5),
    order(11, { buyerClientRef: "cap-b" }, 5),
    order(12, { buyerId: "buyer-1" }, 5),
    order(13, { buyerClientRef: "cap-a" }, 2),
  ];
  it("finds every order linked to the capture being retried", () => {
    expect(ordersWaitingOn(queue, queue[0])).toEqual([10, 13]);
  });
  it("does nothing when an order (not a capture) is retried", () => {
    expect(ordersWaitingOn(queue, queue[1])).toEqual([]);
  });
});
