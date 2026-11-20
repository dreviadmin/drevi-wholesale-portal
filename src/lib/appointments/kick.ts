import "server-only";

import { runAppointmentSender } from "./sender";

// Straight after a booking is made or changed, its due messages (the
// customer's confirmation, the team alerts, a moved or cancelled note) are sent
// without waiting for the 5-minute check. On Vercel this runs after the answer
// has gone back (the platform's waitUntil, which keeps the function alive until
// it is done), so nobody waits for WhatsApp. Where there is no waitUntil it is
// awaited instead, so a message is never left half-sent.

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
type RequestContext = { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined };

/** Runs `job` after the answer has gone back where the platform allows it, else waits for it here. Never throws. */
export async function afterResponse(label: string, job: Promise<unknown>): Promise<void> {
  const safe = job.then(() => undefined, (e) => { console.error(`[appointments] ${label}:`, (e as Error).message); });
  const ctx = (globalThis as unknown as Record<symbol, RequestContext | undefined>)[REQUEST_CONTEXT]?.get?.();
  if (typeof ctx?.waitUntil === "function") {
    try { ctx.waitUntil(safe); return; } catch { /* fall through and wait for it here */ }
  }
  await safe;
}

export async function sendDueNow(appointmentId: string | null | undefined): Promise<void> {
  if (!appointmentId) return;
  await afterResponse("sending after a booking change", runAppointmentSender(new Date(), { appointmentId }));
}
