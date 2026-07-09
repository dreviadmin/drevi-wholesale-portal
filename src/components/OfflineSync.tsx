"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wifi, WifiOff, RefreshCw } from "lucide-react";
import { getQueue, removeQueued, updateQueued, getMeta, setMeta, type CapturePayload, type OrderPayload } from "@/lib/offline";
import { captureBuyer, submitExhibitionOrder } from "@/app/admin/exhibition/actions";
import { palette } from "@/lib/palette";

const MAX_ATTEMPTS = 5;

// Online/offline indicator + reconnect drainer for the exhibition offline queue.
// Drains captures first (so order buyerClientRefs resolve to real ids), then
// orders, with per-item attempt caps and a manual Resend.
export function OfflineSync() {
  const [online, setOnline] = useState(true);
  const [count, setCount] = useState(0);
  const [draining, setDraining] = useState(false);
  const [failed, setFailed] = useState(0);
  // Re-entrancy lock: the mount drain, the `online` event, the 5s poll, and the
  // manual button can all fire drain() at once. Without this, overlapping runs
  // each snapshot the same queue and submit the same order twice (there is no
  // server-side idempotency key yet). A ref, not state, so it's synchronous.
  const drainingRef = useRef(false);

  const refresh = useCallback(async () => {
    const q = await getQueue();
    setCount(q.length);
    setFailed(q.filter((i) => i.attempts >= MAX_ATTEMPTS).length);
  }, []);

  const drain = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (drainingRef.current) return; // never run two drains concurrently
    drainingRef.current = true;
    setDraining(true);
    try {
      const q = await getQueue();
      const refMap: Record<string, string> = (await getMeta("refMap")) ?? {};

      for (const item of q.filter((i) => i.type === "capture")) {
        if (item.attempts >= MAX_ATTEMPTS) continue;
        const cap = item.payload as CapturePayload;
        const res = await captureBuyer(cap.form);
        if (res.ok) { refMap[cap.clientRef] = res.id!; await setMeta("refMap", refMap); await removeQueued(item.id!); }
        else await updateQueued({ ...item, attempts: item.attempts + 1, lastError: res.error });
      }

      for (const item of q.filter((i) => i.type === "order")) {
        if (item.attempts >= MAX_ATTEMPTS) continue;
        const o = item.payload as OrderPayload;
        const buyerId = o.buyerId ?? (o.buyerClientRef ? refMap[o.buyerClientRef] : undefined);
        if (!buyerId) { await updateQueued({ ...item, attempts: item.attempts + 1, lastError: "buyer not synced yet" }); continue; }
        const res = await submitExhibitionOrder({
          sessionId: o.sessionId, eventName: o.eventName, buyerId, items: o.items,
          staffNote: o.staffNote, buyerNote: o.buyerNote,
          taxMode: o.taxMode, taxRate: o.taxRate,
          discountType: o.discountType, discountValue: o.discountValue,
          advanceAmount: o.advanceAmount, paymentMethod: o.paymentMethod, paymentNotes: o.paymentNotes,
        });
        if (res.ok) await removeQueued(item.id!);
        else await updateQueued({ ...item, attempts: item.attempts + 1, lastError: res.error });
      }
    } finally {
      drainingRef.current = false;
      setDraining(false);
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(navigator.onLine);
    refresh();
    const goOnline = () => { setOnline(true); drain(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    if (navigator.onLine) drain();
    const poll = setInterval(refresh, 5000);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); clearInterval(poll); };
  }, [drain, refresh]);

  if (online && count === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 font-body" style={{ background: online ? palette.softBlack : palette.crimsonText, color: palette.ivory, fontSize: 11, letterSpacing: "0.04em", padding: "8px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
      {online ? <Wifi size={13} /> : <WifiOff size={13} />}
      {online ? (count > 0 ? `Syncing ${count} queued…` : "Online") : "Offline — orders will queue"}
      {count > 0 && (
        <button type="button" onClick={drain} disabled={draining} className="flex items-center gap-1 uppercase" style={{ marginLeft: 6, fontSize: 9, letterSpacing: "0.14em", color: palette.champagne }}>
          <RefreshCw size={11} className={draining ? "animate-spin" : ""} /> {failed > 0 ? "Resend" : "Sync"}
        </button>
      )}
    </div>
  );
}
