"use client";

// The Appointment card (with the Meet link), the Stylist picker, and What
// they told us (with Add a note).

import { useState, type ReactNode } from "react";
import { Copy, Link2 } from "lucide-react";
import { palette } from "@/lib/palette";
import { PLACE_LABEL, dayLabel, hm, istParts, showPhone, type ApptSource } from "@/lib/appointments/core";
import { Pill, S, TypeDot, btn } from "../ui";
import { ErrorNote, FOCUS, inputStyle } from "../new/fields";
import { useBooking } from "./ctx";

export function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="font-body" style={{ ...S.card, minWidth: 0 }} aria-label={title}>
      <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
        <h2 style={{ ...S.h3, margin: 0, flex: 1 }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:gap-3 sm:grid-cols-[130px_minmax(0,1fr)]" style={{ padding: "10px 0", borderTop: "1px solid rgba(26,26,26,0.08)" }}>
      <dt style={S.label}>{label}</dt>
      <dd style={{ ...S.body, margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}
const pre = { whiteSpace: "pre-wrap" as const };
const ASKED_ON: Record<ApptSource, string> = { website: "On the website", phone: "On a phone call", whatsapp: "On WhatsApp", instagram: "On Instagram", walkin: "At the shop", other: "Some other way" };

export function AppointmentCard({ staffName }: { staffName: (id: string | null) => string | null }) {
  const { appt: a, type, today } = useBooking();
  const s = istParts(a.starts_at), e = istParts(a.ends_at);
  const minutes = Math.round((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000);
  const made = istParts(a.created_at);
  const by = staffName(a.created_by);
  return (
    <Card title="Appointment">
      <dl style={{ margin: 0 }}>
        <Row label="When"><b>{dayLabel(s.day, today)}</b>, {hm(s.min)} – {hm(e.min)}</Row>
        <Row label="Type"><span className="inline-flex items-center gap-2"><TypeDot typeId={a.type_id} />{type?.name ?? a.type_id} · {minutes} min</span></Row>
        <Row label="Where"><Where /></Row>
        <Row label="Who is coming">{a.party === "group" ? "The customer with family or friends" : "Just the customer"}</Row>
        <Row label="Booked">
          {ASKED_ON[a.source]}{by ? `, by ${by}` : a.source === "website" ? ", by the customer" : ""}
          <span style={{ display: "block", ...S.muted }}>{dayLabel(made.day, today)}, {hm(made.min)}</span>
        </Row>
        {a.outcome ? <Row label="Outcome">{a.outcome}</Row> : null}
        {a.cancel_reason ? <Row label="Why cancelled">{a.cancel_reason}</Row> : null}
      </dl>
    </Card>
  );
}

function Where() {
  const { appt: a, change, busy, errorFor, flash } = useBooking();
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState(a.meet_link ?? "");
  if (a.place === "store") return <>{PLACE_LABEL.store}</>;
  if (a.place === "wa") return <>WhatsApp video: call <b style={{ whiteSpace: "nowrap" }}>{showPhone(a.phone_e164)}</b> from the shop phone.</>;
  const bad = link.trim() !== "" && !/^https:\/\/\S+$/.test(link.trim());
  async function save() {
    if (bad) return;
    if (await change("meet", { kind: "meet", meetLink: link.trim() }, link.trim() ? "Meet link saved" : "Meet link removed")) setEditing(false);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(a.meet_link ?? ""); flash("Meet link copied"); } catch { flash("Could not copy. Press and hold the link to copy it."); }
  }
  return (
    <div className="flex flex-col gap-2">
      <span>{PLACE_LABEL.meet}</span>
      {a.meet_link && !editing ? (
        <>
          <a href={a.meet_link} target="_blank" rel="noopener noreferrer" className={FOCUS} style={{ color: palette.black, textDecoration: "underline", textUnderlineOffset: 3, overflowWrap: "anywhere" }}>{a.meet_link}</a>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={copy} className={FOCUS} style={btn("outline")}><Copy size={14} aria-hidden /> Copy</button>
            <button type="button" onClick={() => { setLink(a.meet_link ?? ""); setEditing(true); }} className={FOCUS} style={btn("ghost")}>Change</button>
          </div>
        </>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          <label className="flex flex-col gap-1.5">
            <span style={S.label}>{a.meet_link ? "Change the Meet link" : "Add the Meet link"}</span>
            <input type="url" inputMode="url" value={link} onChange={(ev) => setLink(ev.target.value)} maxLength={300} placeholder="https://meet.google.com/…" className={FOCUS} style={inputStyle} />
          </label>
          {bad ? <span style={{ fontSize: 12.5, color: palette.crimsonText }}>The link must start with https://</span> : null}
          <div className="flex gap-2 flex-wrap">
            <button type="submit" disabled={bad || busy === "meet" || (!link.trim() && !a.meet_link)} className={`disabled:opacity-40 ${FOCUS}`} style={btn("dark")}><Link2 size={14} aria-hidden /> {busy === "meet" ? "Saving…" : link.trim() || !a.meet_link ? "Save link" : "Remove link"}</button>
            {editing ? <button type="button" onClick={() => setEditing(false)} className={FOCUS} style={btn("ghost")}>Keep the old one</button> : null}
          </div>
          <ErrorNote>{errorFor("meet")}</ErrorNote>
        </form>
      )}
    </div>
  );
}

export function StylistCard() {
  const { appt: a, staff, change, busy, errorFor } = useBooking();
  const known = !a.host_staff_id || staff.some((s) => s.id === a.host_staff_id);
  return (
    <Card title="Stylist">
      <label className="flex flex-col gap-1.5">
        <span style={S.label}>Who looks after them</span>
        <select
          value={a.host_staff_id ?? ""}
          disabled={busy === "host"}
          onChange={(e) => change("host", { kind: "host", hostStaffId: e.target.value || null }, e.target.value ? "Stylist saved" : "Stylist cleared")}
          className={`font-body disabled:opacity-60 ${FOCUS}`}
          style={inputStyle}
        >
          <option value="">Decide later</option>
          {!known ? <option value={a.host_staff_id ?? ""}>A stylist no longer active</option> : null}
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {busy === "host" ? <p style={{ ...S.muted, marginTop: 6 }}>Saving…</p> : null}
      <div style={{ marginTop: 8 }}><ErrorNote>{errorFor("host")}</ErrorNote></div>
    </Card>
  );
}

export function ToldUsCard() {
  const { appt: a, change, busy, errorFor } = useBooking();
  const [note, setNote] = useState("");
  async function add() {
    if (!note.trim()) return;
    if (await change("note", { kind: "note", note: note.trim() }, "Note added")) setNote("");
  }
  return (
    <Card title="What they told us">
      <dl style={{ margin: 0 }}>
        <Row label="Functions">{a.functions.length ? <span className="flex flex-wrap gap-1.5">{a.functions.map((f) => <Pill key={f}>{f}</Pill>)}</span> : <span style={S.muted}>Not given</span>}</Row>
        <Row label="Function date">{a.function_date || <span style={S.muted}>Not given</span>}</Row>
        <Row label="Looking for"><span style={pre}>{a.looking_for || <span style={S.muted}>Not said</span>}</span></Row>
        <Row label="Notes for staff"><span style={pre}>{a.staff_notes || <span style={S.muted}>No notes yet</span>}</span></Row>
      </dl>
      <form className="flex flex-col gap-2" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label className="flex flex-col gap-1.5">
          <span style={S.label}>Add a note</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className={FOCUS} style={{ ...inputStyle, resize: "vertical" }} />
        </label>
        <span style={S.muted}>Only the team sees notes. Your name and the time go in the history.</span>
        <div><button type="submit" disabled={!note.trim() || busy === "note"} className={`disabled:opacity-40 ${FOCUS}`} style={btn("outline")}>{busy === "note" ? "Adding…" : "Add note"}</button></div>
        <ErrorNote>{errorFor("note")}</ErrorNote>
      </form>
    </Card>
  );
}
