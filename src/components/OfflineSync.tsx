"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wifi, WifiOff, RefreshCw, X, RotateCw, Trash2 } from "lucide-react";
import {
  getQueue, removeQueued, updateQueued, resetQueuedAttempts, getMeta, setMeta,
  type CapturePayload, type OrderPayload, type QueueItem,
} from "@/lib/offline";
import { captureBuyer, submitExhibitionOrder } from "@/app/admin/exhibition/actions";
import { palette } from "@/lib/palette";

const MAX_ATTEMPTS = 5;

function itemLabel(item: QueueItem): string {
  if (item.type === "capture") {
    const f = (item.payload as CapturePayload).form;
    return f.business_name || f.owner_name || f.phone || "New buyer";
  }
  const o = item.payload as OrderPayload;
  const pcs = o.items.reduce((n, i) => n + (i.qty || 0), 0);
  return `Order · ${o.items.length} line${o.items.length === 1 ? "" : "s"} · ${pcs} pc`;
}

// Online/offline indicator + reconnect drainer for the exhibition offline queue.
// Drains captures first (so order buyerClientRefs resolve to real ids), then
// orders. Tapping the pill opens a repair panel listing each queued item with
// Retry / Discard — so a stranded (attempt-capped) order is never invisible.
export function OfflineSync() {
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [draining, setDraining] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const drainingRef = useRef(false);

  const count = queue.length;
  const failed = queue.filter((i) => i.attempts >= MAX_ATTEMPTS).length;

  const refresh = useCallback(async () => {
    setQueue(await getQueue());
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
        const res = await captureBuyer({ ...cap.form, clientRef: cap.clientRef });
        if (res.ok) { refMap[cap.clientRef] = res.id!; await setMeta("refMap", refMap); await removeQueued(item.id!); }
        else await updateQueued({ ...item, attempts: item.attempts + 1, lastError: res.error });
      }

      for (const item of q.filter((i) => i.type === "order")) {
        if (item.attempts >= MAX_ATTEMPTS) continue;
        const o = item.payload as OrderPayload;
        const buyerId = o.buyerId ?? (o.buyerClientRef ? refMap[o.buyerClientRef] : undefined);
        if (!buyerId) { await updateQueued({ ...item, attempts: item.attempts + 1, lastError: "buyer not synced yet" }); continue; }
        const res = await submitExhibitionOrder({
          sessionId: o.sessionId, eventName: o.eventName, buyerId, items: o.items, clientRef: o.clientRef,
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
    // The tick also DRAINS when online: items queued while already online
    // (flaky-wifi catch paths, buyer-not-yet-synced orders) never get an
    // 'online' event, so without this they sat until a remount.
    const poll = setInterval(async () => {
      await refresh();
      if (navigator.onLine) {
        const q = await getQueue();
        if (q.some((i) => i.attempts < MAX_ATTEMPTS)) drain();
      }
    }, 5000);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); clearInterval(poll); };
  }, [drain, refresh]);

  async function retryItem(item: QueueItem) {
    await resetQueuedAttempts(item.id!);
    await refresh();
    drain();
  }
  async function discardItem(item: QueueItem) {
    if (!window.confirm(`Discard this queued ${item.type}? This cannot be undone.`)) return;
    await removeQueued(item.id!);
    await refresh();
  }

  if (online && count === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 font-body">
      {expanded && count > 0 && (
        <div style={{ background: palette.ivory, color: palette.black, width: 320, maxWidth: "calc(100vw - 32px)", maxHeight: "60vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.35)", border: "1px solid rgba(26,26,26,0.12)" }}>
          <div className="flex items-center justify-between px-3 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.1)" }}>
            <span className="uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.softBlack }}>Queued ({count})</span>
            <button type="button" onClick={() => setExpanded(false)} aria-label="Close"><X size={15} color={palette.mutedGreige} /></button>
          </div>
          {queue.map((item) => {
            const capped = item.attempts >= MAX_ATTEMPTS;
            return (
              <div key={item.id} className="px-3 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate" style={{ fontSize: 12, fontWeight: 600, color: palette.black }}>{itemLabel(item)}</div>
                    <div style={{ fontSize: 9.5, color: capped ? palette.crimsonText : palette.mutedGreige, letterSpacing: "0.02em" }}>
                      {capped ? "Failed" : `Queued · attempt ${item.attempts}/${MAX_ATTEMPTS}`}{item.lastError ? ` · ${item.lastError}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button type="button" onClick={() => retryItem(item)} aria-label="Retry" className="p-1.5" style={{ border: "1px solid rgba(26,26,26,0.2)" }}><RotateCw size={12} color={palette.black} /></button>
                    <button type="button" onClick={() => discardItem(item)} aria-label="Discard" className="p-1.5" style={{ border: "1px solid rgba(26,26,26,0.2)" }}><Trash2 size={12} color={palette.crimsonText} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2" style={{ background: online ? palette.softBlack : palette.crimsonText, color: palette.ivory, fontSize: 11, letterSpacing: "0.04em", padding: "8px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}>
        {online ? <Wifi size={13} /> : <WifiOff size={13} />}
        <button type="button" onClick={() => setExpanded((v) => !v)} disabled={count === 0} className="disabled:cursor-default" style={{ color: palette.ivory }}>
          {online ? (count > 0 ? `${count} queued${failed > 0 ? ` · ${failed} failed` : ""}` : "Online") : "Offline — orders will queue"}
        </button>
        {count > 0 && (
          <button type="button" onClick={drain} disabled={draining} className="flex items-center gap-1 uppercase" style={{ marginLeft: 4, fontSize: 9, letterSpacing: "0.14em", color: palette.champagne }}>
            <RefreshCw size={11} className={draining ? "animate-spin" : ""} /> Sync
          </button>
        )}
      </div>
    </div>
  );
}
