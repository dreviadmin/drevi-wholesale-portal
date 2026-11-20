"use client";

// The Customer card, and Send on WhatsApp: each button sends the approved
// WhatsApp template from the shop's number through AiSensy straight away (test
// mode sends it to the test number). A sheet asks first, since it cannot be
// taken back. Sent and failed sends show in Messages and in the history.

import { useState } from "react";
import Link from "next/link";
import { MessageCircle, Phone, Send } from "lucide-react";
import { palette } from "@/lib/palette";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import {
  MANUAL_LABEL, TYPE_SPOKEN, dayDiff, dayLong, dayShort, firstName, handText, hm, isLive, istParts, manualRule, showPhone, waDigits, waLink, wentToTest,
  type Appt, type ApptStatus, type ManualWhat,
} from "@/lib/appointments/core";
import type { ApptMessage } from "@/lib/appointments/server";
import { MsgStatePill, S, StatusPill, btn } from "../ui";
import { ErrorNote, FOCUS } from "../new/fields";
import { logHandSend, sendWhatsAppNow } from "../actions";
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

const LABEL: Record<ManualWhat, string> = { confirmation: "Send the confirmation", reminder: "Send a reminder", moved: "Send the new time", cancelled: "Send the cancellation note" };
const SHOP_WA = "+91 84336 59684";
const cancelReason = (a: Appt) => (a.cancel_reason === "Shop closed" ? "The shop is closed then. We are sorry for the trouble." : undefined);

interface Item { what: ManualWhat; rule: string | null; why: string | null; text: string | null; last: ApptMessage | null; reached: ApptMessage | null }

const newestFirst = (messages: ApptMessage[], rule: string) => messages.filter((m) => m.rule === rule && m.audience === "client").sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
/** The message row a Send would go through: the waiting one first, as the sender uses it. */
function lastOf(messages: ApptMessage[], rule: string | null): ApptMessage | null {
  if (!rule) return null;
  const rows = newestFirst(messages, rule);
  return rows.find((m) => m.state === "scheduled" || m.state === "sending") ?? rows[0] ?? null;
}
/** The last one that reached the customer (or may have): a test-mode send never did. */
function reachedOf(messages: ApptMessage[], rule: string | null): ApptMessage | null {
  return rule ? newestFirst(messages, rule).find((m) => (m.state === "sent" && !wentToTest(m)) || m.state === "uncertain") ?? null : null;
}

export function SendWhatsAppCard({ moved, messages }: { moved: boolean; messages: ApptMessage[] }) {
  const { appt: a, types, now, today, run, busy, errorFor, clearError, flash, automationOn, testMode, testNumbers } = useBooking();
  const [askWhat, setAskWhat] = useState<ManualWhat | null>(null);
  const live = isLive(a.status), arrived = a.status === "arrived";

  const whats: ManualWhat[] = live && !arrived ? ["confirmation", "reminder", ...(moved ? (["moved"] as ManualWhat[]) : [])] : a.status === "cancelled" ? ["cancelled"] : [];
  const items: Item[] = whats.map((what) => {
    const pick = manualRule(what, a, now);
    const rule = "rule" in pick ? pick.rule : null;
    let text: string | null = null;
    try { text = rule ? handText(rule, a, types, what === "cancelled" ? { reason: cancelReason(a) } : {}) : null; } catch { text = null; }
    return { what, rule, why: "error" in pick ? pick.error : null, text, last: lastOf(messages, rule), reached: reachedOf(messages, rule) };
  });
  const ask = items.find((it) => it.what === askWhat) ?? null; // always from the latest page data, so a retry sees what changed
  const testTo = testNumbers[0] ? showPhone(testNumbers[0]) : null;
  const keyFor = (it: Item) => `send:${it.what}`;
  // Mirrors the server: outside test mode, a second send of one that reached them is asked about, unless one is still waiting.
  const already = (it: Item) => !testMode && !!it.reached && it.last?.state !== "scheduled";
  const at = (iso: string) => {
    const p = istParts(iso), d = dayDiff(today, p.day);
    return `${d === 0 ? "today" : d === -1 ? "yesterday" : d === 1 ? "tomorrow" : dayShort(p.day)} at ${hm(p.min)}`;
  };
  const statusOf = (st: ApptMessage | null): string | null => !st ? null
    : st.state === "sending" ? "Sending now"
    : st.state === "scheduled" ? (!automationOn ? "Waiting: automatic messages are off, so it will not go by itself"
      : new Date(st.due_at).getTime() > now.getTime() ? `Goes by itself ${at(st.due_at)}` : "Goes within 5 minutes")
    : st.state === "sent" ? (wentToTest(st) ? `Went to the test number ${at(st.sent_at || st.due_at)}, not to the customer` : `Sent ${at(st.sent_at || st.due_at)}`)
    : st.state === "uncertain" ? "May not have gone: check the chat before sending again"
    : st.state === "failed" ? "Did not go"
    : st.state === "skipped" ? `Not sent: ${(st.reason || "skipped").replace(/\.$/, "")}` : null;

  async function send(it: Item) {
    let msg = "Sent";
    const ok = await run(keyFor(it), async () => {
      const r = await sendWhatsAppNow(a.id, it.what, already(it));
      if (r.ok) msg = r.message;
      return r;
    });
    if (ok) { flash(msg); setAskWhat(null); }
  }

  return (
    <Card title="Send on WhatsApp">
      <p style={{ ...S.body, marginBottom: 8 }}>
        Each button sends the approved WhatsApp message from the shop&apos;s number ({SHOP_WA}) to {showPhone(a.phone_e164)} straight away. It shows under Messages.
      </p>
      {testMode ? (
        <p style={{ ...S.body, marginBottom: 8, color: "#5A4210" }}>Test mode is on, so it goes to the test number {testTo ?? "(none added yet, so nothing can go)"}, not to the customer.</p>
      ) : automationOn ? (
        <p style={{ ...S.muted, marginBottom: 8 }}>Automatic messages are on, so the confirmation and reminders go by themselves. Use these when one did not go, or to send one again.</p>
      ) : (
        <p style={{ ...S.muted, marginBottom: 8 }}>Automatic messages are off, so nothing goes on its own. These buttons still send.</p>
      )}
      {!a.notify_wa && live ? <p style={{ ...S.muted, marginBottom: 8 }}>WhatsApp messages are off for this customer. Turn them on in the Customer card to send these.</p> : null}
      {items.length || (live && a.place === "meet") ? (
        <div className="flex flex-col gap-3" style={{ marginTop: 4 }}>
          {items.map((it) => {
            const st = it.last, status = statusOf(st);
            const disabled = !!it.why || !it.rule || st?.state === "sending";
            return (
              <div key={it.what} className="flex flex-col gap-1">
                <button type="button" disabled={disabled || busy === keyFor(it)} onClick={() => { clearError(); setAskWhat(it.what); }}
                  className={`disabled:opacity-40 ${FOCUS}`} style={{ ...btn(it.what === "confirmation" && !already(it) ? "dark" : "outline"), justifyContent: "flex-start", minHeight: 48, width: "100%", maxWidth: 420 }}>
                  <Send size={14} aria-hidden /> {already(it) ? `${LABEL[it.what]} again` : LABEL[it.what]}
                </button>
                {status && !it.why ? <span className="flex items-center gap-2 flex-wrap" style={S.muted}>{st ? <MsgStatePill state={st.state} /> : null}{status}</span> : null}
                {it.why ? <span style={S.muted}>{it.why}</span> : null}
                {!ask && errorFor(keyFor(it)) ? <ErrorNote>{errorFor(keyFor(it))}</ErrorNote> : null}
              </div>
            );
          })}
          {live && a.place === "meet" ? <MeetLinkButton /> : null}
          {items.some((it) => it.text) ? (
            <details style={{ marginTop: 4 }}>
              <summary className={FOCUS} style={{ ...S.label, cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>What the messages say</summary>
              <div className="flex flex-col gap-3" style={{ marginTop: 6 }}>
                {items.filter((it) => it.text).map((it) => (
                  <div key={it.what}>
                    <span style={S.label}>{MANUAL_LABEL[it.what]}</span>
                    <Bubble text={it.text!} />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <p style={S.body}>{arrived ? "They are at the shop, so there is nothing to send." : "This booking is closed, so there is nothing to send. Use Open chat in the Customer card to message them."}</p>
      )}
      {ask ? (
        <ConfirmSheet
          title={already(ask) ? `${LABEL[ask.what]} again?` : `${LABEL[ask.what]} now?`}
          confirmLabel={already(ask) ? "Send again" : "Send"}
          pendingLabel="Sending…"
          cancelLabel="Not now"
          tone="plain"
          pending={busy === keyFor(ask)}
          error={errorFor(keyFor(ask))}
          onConfirm={() => { void send(ask); }}
          onClose={() => { if (busy !== keyFor(ask)) { setAskWhat(null); clearError(); } }}
        >
          <span style={{ display: "block", marginBottom: 8 }}>
            {testMode
              ? `Test mode is on: it goes to the test number ${testTo ?? "(none added)"}, not to ${a.customer_name}.`
              : `It goes on WhatsApp from the shop's number to ${a.customer_name}, ${showPhone(a.phone_e164)}.`}
            {already(ask) && ask.reached
              ? ask.reached.state === "uncertain"
                ? " The last try may or may not have gone. Check the chat on the shop phone first, or they may get it twice."
                : ` It already went ${at(ask.reached.sent_at || ask.reached.due_at)}, so they get it a second time.`
              : !testMode && ask.last?.state === "scheduled" && automationOn && new Date(ask.last.due_at).getTime() > now.getTime() + 5 * 60000
                ? ` It takes the place of the one due to go by itself ${at(ask.last.due_at)}.`
                : ""}
          </span>
          {ask.text ? <Bubble text={ask.text} /> : null}
        </ConfirmSheet>
      ) : null}
    </Card>
  );
}

function Bubble({ text }: { text: string }) {
  return <div style={{ marginTop: 4, background: "#E9F5E1", border: "1px solid #CFE3C2", padding: "9px 11px", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: palette.black, maxHeight: "40vh", overflowY: "auto" }}>{text}</div>;
}

/** No WhatsApp template carries a bare Meet link, so this one opens WhatsApp on the phone with it typed in. */
function MeetLinkButton() {
  const { appt: a, run, errorFor } = useBooking();
  const log = () => { void run("hand", () => logHandSend(a.id, "meet link"), "Opened WhatsApp. Noted in the history."); };
  return (
    <div className="flex flex-col gap-1">
      {a.meet_link ? (
        <a href={waLink(a.phone_e164, meetText(a))} target="_blank" rel="noopener noreferrer" onClick={log} className={FOCUS} style={{ ...btn("outline"), justifyContent: "flex-start", minHeight: 48, width: "100%", maxWidth: 420 }}>
          <MessageCircle size={14} aria-hidden /> Send the Meet link from this phone
        </a>
      ) : (
        <span aria-disabled="true" style={{ ...btn("outline"), justifyContent: "flex-start", minHeight: 48, width: "100%", maxWidth: 420, opacity: 0.4, cursor: "default" }}><MessageCircle size={14} aria-hidden /> Send the Meet link from this phone</span>
      )}
      <span style={S.muted}>{a.meet_link ? "Opens WhatsApp with the link typed in; tap send there. The confirmation and reminders already carry the link." : "Add the Meet link in the Appointment card first."}</span>
      <ErrorNote>{errorFor("hand")}</ErrorNote>
    </div>
  );
}
