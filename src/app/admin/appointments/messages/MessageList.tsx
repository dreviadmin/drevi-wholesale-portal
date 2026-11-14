"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { TEMPLATES, dayLabel, hm, istParts, showPhone } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { MsgStatePill, S } from "../ui";
import { resendMessage } from "../actions";
import { FOCUS, sbtn } from "../settings/bits";
import type { MsgRow } from "./MessagesView";

const who = (r: MsgRow) => (r.audience === "staff" ? `${r.recipient || "Staff"} (staff)` : r.recipient || "Customer");
const addr = (r: MsgRow) => (r.channel === "wa" && r.to.startsWith("+") ? showPhone(r.to) : r.to);

export function MessageList({ rows, today, isAdmin, automationOn, flash }: { rows: MsgRow[]; today: string; isAdmin: boolean; automationOn: boolean; flash: (m: string) => void }) {
  const router = useRouter();
  const [target, setTarget] = useState<MsgRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const days: Array<{ day: string; items: MsgRow[] }> = [];
  for (const r of rows) {
    const d = istParts(r.due).day, last = days[days.length - 1];
    if (last && last.day === d) last.items.push(r); else days.push({ day: d, items: [r] });
  }

  function resend() {
    if (!target) return;
    const id = target.id;
    start(async () => {
      const r = await resendMessage(id);
      if (!r.ok) { setError(r.error); return; }
      setTarget(null); setError(null);
      flash(automationOn ? "Back in the queue: it goes out shortly" : "Back in the queue: it waits until automatic messages are on");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {days.map((g) => (
        <section key={g.day} aria-label={dayLabel(g.day, today)}>
          <h2 className="font-body" style={{ ...S.h3, marginBottom: 4, color: g.day === today ? palette.black : palette.softBlack }}>{dayLabel(g.day, today)} · {g.items.length}</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)" }}>
            {g.items.map((r, i) => {
              const tpl = TEMPLATES[r.template];
              const trouble = r.state === "failed" || r.state === "uncertain";
              const sentAt = r.state === "sent" && r.sentAt && Math.abs(new Date(r.sentAt).getTime() - new Date(r.due).getTime()) > 5 * 60000 ? hm(istParts(r.sentAt).min) : null;
              const notes = [r.reason, trouble && r.lastError && r.lastError !== r.reason ? r.lastError : null, r.attempts > 1 ? `Tried ${r.attempts} times` : null, sentAt ? `Sent at ${sentAt}` : null].filter(Boolean) as string[];
              return (
                <li key={r.id} className="flex gap-3 flex-wrap sm:flex-nowrap" style={{ padding: "12px 14px", borderTop: i ? "1px solid rgba(26,26,26,0.08)" : undefined, alignItems: "flex-start" }}>
                  <span className="font-body" style={{ width: 64, flex: "none", fontSize: 13, fontWeight: 600, color: palette.black, fontVariantNumeric: "tabular-nums", paddingTop: 1 }}>{hm(istParts(r.due).min)}</span>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>{tpl?.title ?? r.template}</span>
                      <MsgStatePill state={r.state} />
                    </div>
                    <p className="font-body" style={{ fontSize: 12.5, color: palette.softBlack, marginTop: 3, wordBreak: "break-word" }}>
                      To {who(r)} · <span style={{ fontVariantNumeric: "tabular-nums" }}>{addr(r)}</span>
                      {r.number && <> · <Link href={`/admin/appointments/${r.number}`} className={FOCUS} style={{ color: palette.black, fontWeight: 600, textDecoration: "underline", display: "inline-block", padding: "4px 0" }}>Booking {r.number}</Link></>}
                    </p>
                    {notes.length > 0 && <p className="font-body" style={{ fontSize: 11.5, color: trouble ? palette.crimsonText : palette.mutedGreige, marginTop: 2, lineHeight: 1.45, wordBreak: "break-word" }}>{notes.join(" · ")}</p>}
                  </div>
                  {isAdmin && trouble && (
                    <button type="button" onClick={() => { setTarget(r); setError(null); }} className={`font-body ${FOCUS}`} style={{ ...sbtn("outline"), marginLeft: "auto" }}>
                      <RotateCcw size={14} aria-hidden /> Send again
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {target && (
        <ConfirmSheet title="Send this message again?" confirmLabel="Send again" pendingLabel="Putting it back…" cancelLabel="Not now" tone="plain" pending={pending} error={error}
          onConfirm={resend} onClose={() => { if (!pending) { setTarget(null); setError(null); } }}>
          <b>{TEMPLATES[target.template]?.title ?? target.template}</b> to {who(target)}, {addr(target)}.{" "}
          {target.state === "uncertain"
            ? "The sender lost contact while sending this, so it may already have arrived. Check with them first, or they could get it twice."
            : "The last try failed."}{" "}
          {automationOn ? "It goes back in the queue and is sent shortly." : "Automatic messages are off, so it waits in the queue until they are turned on."}
        </ConfirmSheet>
      )}
    </div>
  );
}
