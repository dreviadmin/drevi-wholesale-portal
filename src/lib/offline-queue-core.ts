import type { CapturePayload, OrderPayload, QueueItem } from "./offline";

// The PURE half of the exhibition offline queue's drain rules (audit fix,
// 4 Oct) — no idb, no React, so vitest can hold them still. Type-only import
// above: nothing from offline.ts (which opens IndexedDB) is loaded at runtime.
//
// The bug these close: an order queued against an offline-captured buyer
// can't go until that capture lands, and every drain it waited used to burn
// one of the ORDER's five attempts ("buyer not synced yet"). A booth server
// down for ~30 s capped both together, so the order showed Failed for a
// failure that was the capture's — and stayed Failed after staff retried the
// capture and it went through.

/**
 * Client refs of the captures that are still being retried after this
 * drain's capture pass: queued, failed this time, and still under the cap.
 * `attemptsAfter` maps a capture's queue id to its attempt count once this
 * drain is done with it; a capture absent from it (it synced and left the
 * queue) is not retrying.
 */
export function retryingCaptureRefs(
  captures: QueueItem[],
  attemptsAfter: Map<number, number>,
  maxAttempts: number,
): Set<string> {
  const out = new Set<string>();
  for (const c of captures) {
    if (c.type !== "capture" || c.id == null) continue;
    const n = attemptsAfter.get(c.id);
    if (n != null && n < maxAttempts) out.add((c.payload as CapturePayload).clientRef);
  }
  return out;
}

/**
 * Does an order whose buyer has no id yet spend an attempt this drain?
 * Not while its capture is still retrying — that wait is the capture's to
 * count, and the capture has its own cap, so this can't wait forever. Once
 * the capture is capped or discarded the order counts again and reaches
 * Failed exactly as before, so a stranded order is never invisible.
 */
export function unsyncedBuyerCountsAttempt(order: OrderPayload, retrying: Set<string>): boolean {
  return !(order.buyerClientRef && retrying.has(order.buyerClientRef));
}

/**
 * Queue ids of the orders waiting on this capture. Retrying a capture resets
 * them too: if both had capped, the capture going through would otherwise
 * leave its order Failed until staff found and retried that as well.
 */
export function ordersWaitingOn(queue: QueueItem[], capture: QueueItem): number[] {
  if (capture.type !== "capture") return [];
  const ref = (capture.payload as CapturePayload).clientRef;
  if (!ref) return [];
  return queue
    .filter((i) => i.type === "order" && i.id != null && (i.payload as OrderPayload).buyerClientRef === ref)
    .map((i) => i.id as number);
}

/**
 * What the drain does with a queued order once the server has answered: take
 * it off the queue, or keep it with the reason showing (lastError) and count
 * the attempt.
 *
 * A saved order that came back with a warning stays (Nov review): the warning
 * says its staff note did not save, and the queue item is the only other copy
 * of that note. The drain used to drop both without a word. Kept, the next
 * drain replays it, and the replay finds the saved order by its clientRef and
 * files the note then; at the attempt cap it shows Failed with the warning,
 * so staff can add the note by hand and Discard. An order without a clientRef
 * cannot be replayed without billing it twice, so it still leaves the queue.
 */
export function orderDrainOutcome(
  order: OrderPayload,
  res: { ok: boolean; error?: string; warning?: string; orderNumber?: string },
): { remove: true } | { remove: false; lastError?: string } {
  if (!res.ok) return { remove: false, lastError: res.error };
  if (!res.warning || !order.clientRef) return { remove: true };
  return { remove: false, lastError: res.orderNumber ? `${res.orderNumber}: ${res.warning}` : res.warning };
}
