"use client";

import { useEffect, useState } from "react";
import { palette } from "@/lib/palette";

// The Generate-bill bar disappears the moment its bill lands (the page
// refreshes with nothing left to bill), taking its message with it — including
// "its PDF failed" (30 Sep review). The bar leaves the message here instead,
// under the Bills heading, for one showing.
export const billResultKey = (orderId: string) => `drevi:billResult:${orderId}`;

export function BillResultNote({ orderId }: { orderId: string }) {
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(billResultKey(orderId));
      if (!raw) return;
      sessionStorage.removeItem(billResultKey(orderId));
      const parsed = JSON.parse(raw) as { text: string; bad: boolean; at: number };
      if (Date.now() - parsed.at < 60_000) setNote({ text: parsed.text, bad: parsed.bad });
    } catch { /* storage unavailable — the bill row itself still shows the state */ }
  }, [orderId]);
  if (!note) return null;
  return (
    <div className="font-body mt-1.5" style={{ fontSize: 11, fontWeight: 600, color: note.bad ? palette.crimsonText : palette.goldDeep }}>
      {note.text}
    </div>
  );
}
