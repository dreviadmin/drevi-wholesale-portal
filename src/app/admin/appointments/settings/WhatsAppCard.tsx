"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dayDiff, dayShort, hm, istParts, showPhone, type ApptSettings } from "@/lib/appointments/core";
import type { SenderStatus } from "@/lib/appointments/sender";
import { palette } from "@/lib/palette";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { Pill, S, btn } from "../ui";
import { saveSettings } from "../actions";
import { FOCUS, InlineError, PhoneField, Section, phoneOf, sbtn } from "./bits";
import { CampaignNames } from "./CampaignNames";

type Ask = "automation_on" | "test_off" | null;

export function WhatsAppCard({ settings, sender, today, nowIso, isOwner, flash }: { settings: ApptSettings; sender: SenderStatus; today: string; nowIso: string; isOwner: boolean; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const on = settings.automation_on, test = settings.test_mode;

  function apply(v: { automation_on?: boolean; test_mode?: boolean }, done: string, fromSheet = false) {
    if (!fromSheet) setError(null);
    start(async () => {
      const r = await saveSettings(v);
      if (!r.ok) { if (fromSheet) setAskErr(r.error); else setError(r.error); return; }
      setAsk(null); setAskErr(null);
      flash(done);
      router.refresh();
    });
  }

  const ownerOnly = <span className="font-body block" style={{ ...S.muted, marginTop: 4 }}>Only the owner can do this.</span>;

  return (
    <Section id="whatsapp" title="WhatsApp messages"
      intro={<>Confirmations and reminders to customers, and alerts to the people above, sent through AiSensy. Only the owner can turn automatic messages on or test mode off; an admin can always turn automatic messages off or test mode back on. While test mode is on, messages go only to the test numbers. Every message, sent or waiting, is listed under <Link href="/admin/appointments/messages" className={FOCUS} style={{ textDecoration: "underline", color: palette.black }}>Messages</Link>.</>}>
      <div className="grid gap-3 md:grid-cols-2">
        <div style={{ border: "1px solid rgba(26,26,26,0.12)", background: "#fff", padding: 14 }}>
          <div className="flex items-center gap-2 flex-wrap"><span className="font-body" style={S.label}>Automatic messages</span>{on ? <Pill bg="#E1EFE4" fg="#245437">On</Pill> : <Pill bg="#ECE9E4" fg="#7A746B">Off</Pill>}</div>
          <p className="font-body" style={{ ...S.body, marginTop: 6, lineHeight: 1.5 }}>
            {on ? "The portal sends the WhatsApps itself: the confirmation and team alerts as soon as a booking is made, reminders at their time." : "Nothing is sent automatically. Staff send confirmations and reminders with the Send buttons on each booking."}
          </p>
          <div style={{ marginTop: 10 }}>
            {on ? (
              <button type="button" disabled={pending} onClick={() => apply({ automation_on: false }, "Automatic messages are off")} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("outline")}>Turn off</button>
            ) : (
              <>
                <button type="button" disabled={pending || !isOwner} onClick={() => { setAsk("automation_on"); setAskErr(null); }} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("gold")}>Turn on</button>
                {!isOwner && ownerOnly}
              </>
            )}
          </div>
        </div>
        <div style={{ border: "1px solid rgba(26,26,26,0.12)", background: "#fff", padding: 14 }}>
          <div className="flex items-center gap-2 flex-wrap"><span className="font-body" style={S.label}>Test mode</span>{test ? <Pill bg="#FBEFD2" fg="#7A4E00">On</Pill> : <Pill bg="#ECE9E4" fg="#7A746B">Off</Pill>}</div>
          <p className="font-body" style={{ ...S.body, marginTop: 6, lineHeight: 1.5 }}>
            {test ? `Messages go only to the test numbers below${settings.test_numbers.length ? "" : " (none added yet, so nothing goes out)"}.` : "Messages go to the customers and staff they are meant for."}
          </p>
          <div style={{ marginTop: 10 }}>
            {test ? (
              <>
                <button type="button" disabled={pending || !isOwner} onClick={() => { setAsk("test_off"); setAskErr(null); }} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("outline")}>Turn test mode off</button>
                {!isOwner && ownerOnly}
              </>
            ) : (
              <button type="button" disabled={pending} onClick={() => apply({ test_mode: true }, "Test mode is on")} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("outline")}>Turn test mode back on</button>
            )}
          </div>
        </div>
      </div>
      <InlineError>{error}</InlineError>
      <SenderHealth sender={sender} today={today} nowIso={nowIso} on={on} />

      <TestNumbers numbers={settings.test_numbers} flash={flash} />
      <CampaignNames campaigns={settings.campaigns} flash={flash} />

      {ask === "automation_on" && (
        <ConfirmSheet title="Turn automatic messages on?" confirmLabel="Turn on" pendingLabel="Turning on…" cancelLabel="Not now" tone="plain" pending={pending} error={askErr}
          onConfirm={() => apply({ automation_on: true }, "Automatic messages are on", true)} onClose={() => { if (!pending) setAsk(null); }}>
          {test
            ? `Test mode is on, so messages go only to the test numbers (${settings.test_numbers.length ? settings.test_numbers.map(showPhone).join(", ") : "none added yet"}).`
            : "Test mode is off: customers and staff start getting WhatsApps for their bookings."}
          {" "}Check that every message below has its AiSensy campaign name first.
        </ConfirmSheet>
      )}
      {ask === "test_off" && (
        <ConfirmSheet title="Turn test mode off?" confirmLabel="Turn test mode off" pendingLabel="Turning off…" cancelLabel="Keep test mode" tone="danger" pending={pending} error={askErr}
          onConfirm={() => apply({ test_mode: false }, "Test mode is off", true)} onClose={() => { if (!pending) setAsk(null); }}>
          {on
            ? "Customers and staff start getting the WhatsApps for real."
            : "Automatic messages are off, so nothing goes yet. Once they are on, messages go to the customers and staff they are meant for."}
        </ConfirmSheet>
      )}
    </Section>
  );
}

function TestNumbers({ numbers, flash }: { numbers: string[]; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cc, setCc] = useState("+91");
  const [local, setLocal] = useState("");
  const wa = phoneOf(cc, local);

  function save(next: string[], done: string, after?: () => void) {
    setError(null);
    start(async () => {
      const r = await saveSettings({ test_numbers: next });
      if (!r.ok) { setError(r.error); return; }
      after?.();
      flash(done);
      router.refresh();
    });
  }
  function add() {
    if (!wa) { setError("That number does not look right. A 10-digit Indian mobile, or pick the country first."); return; }
    if (numbers.includes(wa)) { setError(`${showPhone(wa)} is already on the list.`); return; }
    save([...numbers, wa], `${showPhone(wa)} added`, () => setLocal(""));
  }

  return (
    <div style={{ borderTop: "1px solid rgba(26,26,26,0.12)", marginTop: 16, paddingTop: 14 }}>
      <h3 className="font-body" style={S.h3}>Test numbers</h3>
      <p className="font-body" style={{ ...S.muted, marginBottom: 8 }}>While test mode is on, messages go only to these numbers. Add the people who are trying it out, such as yourself.</p>
      {numbers.length === 0 ? (
        <p className="font-body" style={{ ...S.body, color: palette.softBlack }}>No test numbers yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, maxWidth: 520 }}>
          {numbers.map((n) => (
            <li key={n} className="flex items-center gap-3" style={S.row}>
              <span className="font-body" style={{ ...S.body, flex: 1, fontVariantNumeric: "tabular-nums" }}>{showPhone(n)}</span>
              <button type="button" disabled={pending} onClick={() => save(numbers.filter((x) => x !== n), `${showPhone(n)} removed`)} className={`font-body disabled:opacity-40 ${FOCUS}`} style={sbtn("ghost")} aria-label={`Remove ${showPhone(n)}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2 flex-wrap" style={{ marginTop: 10, maxWidth: 520 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}><PhoneField id="test-number" label="Add a test number" cc={cc} local={local} onChange={(c, l) => { setCc(c); setLocal(l); }} /></div>
        <button type="button" disabled={pending || !local.trim()} onClick={add} className={`font-body disabled:opacity-40 ${FOCUS}`} style={{ ...btn("dark"), marginTop: 22 }}>{pending ? "Saving…" : "Add"}</button>
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** Whether the 5-minute check (0113) is running: reminders depend on it. */
function SenderHealth({ sender, today, nowIso, on }: { sender: SenderStatus; today: string; nowIso: string; on: boolean }) {
  const last = sender.lastRunAt ? istParts(sender.lastRunAt) : null;
  const when = last ? `${dayDiff(today, last.day) === 0 ? "today" : dayDiff(today, last.day) === -1 ? "yesterday" : dayShort(last.day)} at ${hm(last.min)}` : null;
  const minsAgo = sender.lastRunAt ? (Date.parse(nowIso) - Date.parse(sender.lastRunAt)) / 60000 : Infinity;
  const ok = sender.ready && sender.registered && minsAgo <= 15 && sender.lastVia === "database" && !sender.note;
  const waiting = sender.ready && sender.registered && !sender.lastRunAt;
  const text = !sender.ready
    ? "The 5-minute check is not set up on this database yet (migration 0113). Until it is, due messages go only when GitHub calls in, a few times a day, so reminders can be hours late."
    : !sender.registered
      ? "The 5-minute check starts once the portal has noted its own address. That happens when this page or the sender runs on the live portal."
      : ok
        ? `Due messages are checked every 5 minutes. Last check ${when}.`
        : !when
          ? "Due messages are checked every 5 minutes. The first check runs within 5 minutes; reload this page to see it."
          : sender.note && minsAgo <= 15
            ? `The last check, ${when}, could not finish, so messages may be late.`
            : sender.lastVia === "github" && minsAgo <= 15
              ? `The last check was GitHub's, ${when}. The 5-minute check from the database has not run since, so reminders may be late.`
              : `No check since ${when}. Reminders are late until the check runs again${on ? "" : " (automatic messages are off, so nothing is waiting to go)"}.`;
  return (
    <div className="font-body" role={ok ? undefined : "status"} style={{ marginTop: 12, border: `1px solid ${ok ? "rgba(26,26,26,0.12)" : "#EBD39A"}`, background: ok ? "#fff" : "#FFF8E6", padding: "10px 14px", maxWidth: 680 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span style={S.label}>Sending schedule</span>
        {ok ? <Pill bg="#E1EFE4" fg="#245437">Running</Pill> : waiting ? <Pill bg="#ECE9E4" fg="#7A746B">Starting</Pill> : <Pill bg="#FBEFD2" fg="#7A4E00">Check</Pill>}
      </div>
      <p style={{ ...S.body, marginTop: 6, lineHeight: 1.5, color: ok ? palette.black : "#5A4210" }}>{text}</p>
      {sender.note ? <p style={{ ...S.muted, marginTop: 4, overflowWrap: "anywhere" }}>Last error: {sender.note}</p> : null}
    </div>
  );
}
