"use client";

// The Customer card, and WhatsApp by hand: while automatic sending is off,
// these buttons are how the customer hears from us. Each opens WhatsApp with
// the message typed in and is noted in the history.

import Link from "next/link";
import { MessageCircle, Phone, Send } from "lucide-react";
import { palette } from "@/lib/palette";
import {
  TYPE_SPOKEN, dayLong, dayShort, firstName, handConfirmText, handReminderText, hm, isLive, istParts, renderParams, renderText, showPhone, waDigits, waLink,
  type Appt, type ApptStatus,
} from "@/lib/appointments/core";
import { S, StatusPill, btn } from "../ui";
import { ErrorNote, FOCUS } from "../new/fields";
import { logHandSend } from "../actions";
import { Card, Row } from "./DetailCards";
import { useBooking } from "./ctx";

export function CustomerCard({ others }: { others: Array<{ number: string; starts_at: string; status: ApptStatus }> }) {
  const { appt: a, change, busy, errorFor } = useBooking();
  return (
    <Card title="Customer">
      <dl style={{ margin: 0 }}>
        <Row label="Name">{a.customer_name}</Row>
        <Row label="WhatsApp">
          <span style={{ whiteSpace: "nowrap" }}>{showPhone(a.phone_e164)}</span>
          <span className="flex gap-2 flex-wrap" style={{ marginTop: 8 }}>
            <a href={`tel:${a.phone_e164}`} className={FOCUS} style={btn("outline")}><Phone size={14} aria-hidden /> Call</a>
            <a href={`https://wa.me/${waDigits(a.phone_e164)}`} target="_blank" rel="noopener noreferrer" className={FOCUS} style={btn("outline")}><MessageCircle size={14} aria-hidden /> Open chat</a>
          </span>
        </Row>
        <Row label="Email">{a.email ? <a href={`mailto:${a.email}`} className={FOCUS} style={{ color: palette.black, textDecoration: "underline", textUnderlineOffset: 3 }}>{a.email}</a> : <span style={S.muted}>Not given</span>}</Row>
        <Row label="WhatsApp messages">
          <span style={{ display: "block" }}>{a.notify_wa ? "On: the confirmation and reminders go to this number." : "Off: no WhatsApp messages go to them."}</span>
          {isLive(a.status) ? <button
            type="button"
            disabled={busy === "notify"}
            onClick={() => change("notify", { kind: "edit", edit: { notifyWa: !a.notify_wa } }, a.notify_wa ? "WhatsApp messages off" : "WhatsApp messages on")}
            className={`disabled:opacity-50 ${FOCUS}`}
            style={{ ...btn("outline"), marginTop: 8 }}
          >
            {busy === "notify" ? "Saving…" : a.notify_wa ? "Turn them off" : "Turn them on"}
          </button> : null}
          <div style={{ marginTop: 6 }}><ErrorNote>{errorFor("notify")}</ErrorNote></div>
        </Row>
        <Row label="Other bookings">
          {others.length ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {others.map((o) => (
                <li key={o.number}>
                  <Link href={`/admin/appointments/${o.number}`} className={`flex items-center gap-2 flex-wrap ${FOCUS}`} style={{ minHeight: 44, color: palette.black, textDecoration: "none" }}>
                    <span style={{ fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3 }}>{o.number}</span>
                    <span style={{ color: palette.softBlack }}>{dayShort(istParts(o.starts_at).day)}, {hm(istParts(o.starts_at).min)}</span>
                    <StatusPill status={o.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : <span style={S.muted}>No other bookings with this number.</span>}
        </Row>
      </dl>
    </Card>
  );
}

function meetText(a: Appt): string {
  const p = istParts(a.starts_at), t = hm(p.min);
  const time = a.phone_e164.startsWith("+91") ? t : `${t} India time`;
  return `Hi ${firstName(a.customer_name)}, here is the Google Meet link for your ${TYPE_SPOKEN[a.type_id] ?? "appointment"} with Drevi on ${dayLong(p.day)} at ${time}:\n${a.meet_link}\nSee you then.`;
}

type What = "confirmation" | "reminder" | "meet link" | "message";

export function HandWhatsAppCard({ moved }: { moved: boolean }) {
  const { appt: a, types, now, run, errorFor, automationOn, testMode } = useBooking();
  const live = isLive(a.status);
  const log = (what: What) => { void run("hand", () => logHandSend(a.id, what), "Opened WhatsApp. Noted in the history."); };

  const items: Array<{ key: string; label: string; text: string | null; what: What; note?: string }> = [];
  if (live) {
    items.push({ key: "confirm", label: "Send the confirmation", text: handConfirmText(a, types), what: "confirmation", note: a.status === "requested" ? "It still needs confirming: tap Confirm above first." : undefined });
    items.push({ key: "remind", label: "Send a reminder", text: handReminderText(a, types, now), what: "reminder" });
    if (moved) items.push({ key: "moved", label: "Send the new time", text: renderText("drevi_appt_moved", renderParams("drevi_appt_moved", a, { types })), what: "message" });
    if (a.place === "meet") items.push({ key: "meet", label: "Send the Meet link", text: a.meet_link ? meetText(a) : null, what: "meet link", note: a.meet_link ? undefined : "Add the Meet link in the Appointment card first." });
  } else if (a.status === "cancelled") {
    items.push({ key: "cancel", label: "Send the cancellation note", text: renderText("drevi_appt_cancelled", renderParams("drevi_appt_cancelled", a, { types })), what: "message" });
  }

  return (
    <Card title="WhatsApp by hand">
      {automationOn && !testMode ? <p style={{ ...S.body, marginBottom: 8 }}>Automatic messages are on, so these usually go by themselves. Use the buttons only when the Messages card shows one did not go.</p> : null}
      <p style={{ ...S.muted, marginBottom: 12 }}>
        Each button opens WhatsApp on this phone, or WhatsApp Web on a laptop, with the message to {showPhone(a.phone_e164)} typed in. Check it, then tap send. The tap is noted in the history.
      </p>
      {items.length ? (
        <div className="flex flex-col gap-3">
          {items.map((it) => (
            <div key={it.key} className="flex flex-col gap-1">
              {it.text ? (
                <a href={waLink(a.phone_e164, it.text)} target="_blank" rel="noopener noreferrer" onClick={() => log(it.what)} className={FOCUS} style={{ ...btn(it.key === "confirm" && a.status !== "requested" ? "dark" : "outline"), justifyContent: "flex-start", minHeight: 48 }}>
                  <Send size={14} aria-hidden /> {it.label}
                </a>
              ) : (
                <span aria-disabled="true" style={{ ...btn("outline"), justifyContent: "flex-start", minHeight: 48, opacity: 0.4, cursor: "default" }}><Send size={14} aria-hidden /> {it.label}</span>
              )}
              {it.note ? <span style={S.muted}>{it.note}</span> : null}
            </div>
          ))}
          <details style={{ marginTop: 4 }}>
            <summary className={FOCUS} style={{ ...S.label, cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>What the messages say</summary>
            <div className="flex flex-col gap-3" style={{ marginTop: 6 }}>
              {items.filter((it) => it.text).map((it) => (
                <div key={it.key}>
                  <span style={S.label}>{it.label.replace(/^Send /, "")}</span>
                  <div style={{ marginTop: 4, background: "#E9F5E1", border: "1px solid #CFE3C2", padding: "9px 11px", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: palette.black }}>{it.text}</div>
                </div>
              ))}
            </div>
          </details>
        </div>
      ) : (
        <p style={S.body}>This booking is closed, so there is nothing to send. Use Open chat in the Customer card to message them.</p>
      )}
      <div style={{ marginTop: 8 }}><ErrorNote>{errorFor("hand")}</ErrorNote></div>
    </Card>
  );
}
