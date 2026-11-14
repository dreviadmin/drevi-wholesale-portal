"use client";

// Messages (planned and sent, from the queue) and History (newest first).

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { palette } from "@/lib/palette";
import { TEMPLATES, dayLabel, hm, istParts, showPhone } from "@/lib/appointments/core";
import type { ApptEvent, ApptMessage } from "@/lib/appointments/server";
import { MsgStatePill, S, btn } from "../ui";
import { ErrorNote, FOCUS } from "../new/fields";
import { resendMessage } from "../actions";
import { Card } from "./DetailCards";
import { useBooking } from "./ctx";

function at(iso: string, today: string): string { const p = istParts(iso); return `${dayLabel(p.day, today)}, ${hm(p.min)}`; }
const phoneish = (s: string) => (/^\+\d{8,15}$/.test(s) ? showPhone(s) : s);

export function MessagesCard({ messages }: { messages: ApptMessage[] }) {
  const { isAdmin, today, run, busy, errorFor } = useBooking();
  return (
    <Card title="Messages">
      {messages.length ? (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {messages.map((m) => {
            const tpl = TEMPLATES[m.template];
            const canResend = isAdmin && (m.state === "failed" || m.state === "uncertain");
            const key = `resend:${m.id}`;
            return (
              <li key={m.id} style={{ padding: "11px 0", borderTop: "1px solid rgba(26,26,26,0.08)" }}>
                <div className="flex items-start gap-2 flex-wrap">
                  <span style={{ ...S.body, fontWeight: 600, flex: "1 1 180px", minWidth: 0 }}>{tpl?.title ?? m.template}</span>
                  <MsgStatePill state={m.state} />
                </div>
                <div style={{ ...S.muted, marginTop: 3, overflowWrap: "anywhere" }}>
                  {m.audience === "staff" ? "To staff: " : "To the customer: "}
                  {m.recipient_name ? `${m.recipient_name}, ` : ""}{phoneish(m.to_address)}
                </div>
                <div style={{ ...S.muted, marginTop: 2 }}>
                  {m.state === "sent" && m.sent_at ? `Sent ${at(m.sent_at, today)}` : `Due ${at(m.due_at, today)}`}
                </div>
                {m.reason || m.last_error ? <div style={{ fontSize: 12.5, color: m.state === "failed" ? palette.crimsonText : palette.softBlack, marginTop: 3, overflowWrap: "anywhere" }}>{m.reason || m.last_error}</div> : null}
                {canResend ? (
                  <div style={{ marginTop: 8 }} className="flex flex-col gap-2">
                    <div>
                      <button type="button" disabled={busy === key} onClick={() => run(key, () => resendMessage(m.id), "Put back in the queue")} className={`disabled:opacity-50 ${FOCUS}`} style={btn("outline")}>
                        <RotateCw size={14} aria-hidden /> {busy === key ? "Sending…" : "Send again"}
                      </button>
                    </div>
                    <span style={S.muted}>{m.state === "uncertain" ? "Check with them first that it did not arrive, so they do not get it twice." : "It goes back in the queue and is tried again now."}</span>
                    <ErrorNote>{errorFor(key)}</ErrorNote>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p style={S.body}>No WhatsApp messages are planned for this booking. They are planned once it is confirmed with WhatsApp messages on.</p>
      )}
    </Card>
  );
}

export function HistoryCard({ events }: { events: ApptEvent[] }) {
  const { today } = useBooking();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 12);
  return (
    <Card title="History">
      {events.length ? (
        <>
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {shown.map((e) => (
              <li key={e.id} style={{ padding: "10px 0", borderTop: "1px solid rgba(26,26,26,0.08)" }}>
                <div style={{ ...S.body, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{e.text}</div>
                <div style={{ ...S.muted, marginTop: 2 }}>{at(e.at, today)}{e.by_name ? ` · ${e.by_name}` : ""}</div>
              </li>
            ))}
          </ol>
          {events.length > shown.length ? (
            <button type="button" onClick={() => setAll(true)} className={FOCUS} style={{ ...btn("ghost"), marginTop: 6 }}>Show all {events.length}</button>
          ) : null}
        </>
      ) : (
        <p style={S.body}>Nothing has happened to this booking yet.</p>
      )}
    </Card>
  );
}
