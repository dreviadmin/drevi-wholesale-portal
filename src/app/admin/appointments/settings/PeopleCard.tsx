"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { hm, showPhone, type Person } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { S, btn } from "../ui";
import { savePerson, removePerson } from "../actions";
import { FOCUS, FieldLabel, INPUT, InlineError, PhoneField, Section, Toggle, phoneOf, splitE164, sbtn } from "./bits";
import type { Login } from "./SettingsView";

type Flags = Pick<Person, "on_new" | "on_change" | "on_digest" | "on_heads_up">;
const ROLE: Record<string, string> = { super_admin: "Owner", admin: "Admin", staff: "Staff" };
const loginLabel = (l: Login) => `${l.name} (${ROLE[l.role] ?? l.role})`;

function switches(digestHour: number): Array<{ k: keyof Flags; label: string; hint: string }> {
  return [
    { k: "on_new", label: "New bookings", hint: "Each new booking, and a nudge if one still needs confirming 2 hours later." },
    { k: "on_change", label: "Changes", hint: "When a booking is moved or cancelled." },
    { k: "on_digest", label: "Daily list", hint: `The day's appointments, every morning at ${hm(digestHour * 60)}.` },
    { k: "on_heads_up", label: "Heads-up 30 minutes before", hint: "Before each appointment. When the booking has a stylist who has this on, only they get it." },
  ];
}

export function PeopleCard({ people, logins, digestHour, flash }: { people: Person[]; logins: Login[]; digestHour: number; flash: (m: string) => void }) {
  const active = people.filter((p) => p.active), off = people.filter((p) => !p.active);
  return (
    <Section id="people" title="Who gets staff messages"
      intro={<>The WhatsApp alerts for the shop team. Anyone can be on this list, with or without a portal login. Link a person&apos;s login so the portal knows who they are: the person who makes a booking is not alerted about it.</>}>
      {active.length === 0 ? (
        <p className="font-body" style={{ ...S.body, color: palette.softBlack }}>Nobody gets staff messages yet. Add the first person below.</p>
      ) : (
        active.map((p) => <PersonRow key={p.id} p={p} logins={logins} digestHour={digestHour} flash={flash} />)
      )}
      {off.length > 0 && (
        <details style={{ borderTop: "1px solid rgba(26,26,26,0.08)", marginTop: 4 }}>
          <summary className={`font-body ${FOCUS}`} style={{ ...S.label, minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer" }}>Switched off ({off.length})</summary>
          {off.map((p) => <OffRow key={p.id} p={p} flash={flash} />)}
        </details>
      )}
      <AddPerson logins={logins} digestHour={digestHour} flash={flash} />
    </Section>
  );
}

function PersonRow({ p, logins, digestHour, flash }: { p: Person; logins: Login[]; digestHour: number; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flags, setFlags] = useState<Flags>({ on_new: p.on_new, on_change: p.on_change, on_digest: p.on_digest, on_heads_up: p.on_heads_up });
  const [editing, setEditing] = useState(!p.wa_e164);
  const [name, setName] = useState(p.name);
  const split = splitE164(p.wa_e164);
  const [cc, setCc] = useState(split.cc);
  const [local, setLocal] = useState(split.local);
  const [staffId, setStaffId] = useState(p.staff_id ?? "");
  const wa = phoneOf(cc, local);
  const login = logins.find((l) => l.id === p.staff_id);
  const dirty = (Object.keys(flags) as Array<keyof Flags>).some((k) => flags[k] !== p[k]) || name.trim() !== p.name || wa !== p.wa_e164 || (staffId || null) !== p.staff_id;

  function save() {
    if (!name.trim()) { setError("Enter a name."); return; }
    if (!wa) { setEditing(true); setError("That WhatsApp number does not look right."); return; }
    setError(null);
    start(async () => {
      const r = await savePerson({ id: p.id, name: name.trim(), wa, staffId: staffId || null, ...flags, active: true });
      if (!r.ok) { setError(r.error); return; }
      setEditing(false);
      flash(`${name.trim()} saved`);
      router.refresh();
    });
  }
  function switchOff() {
    setError(null);
    start(async () => {
      const r = await removePerson(p.id);
      if (!r.ok) { setError(r.error); return; }
      flash(`${p.name} gets no more staff messages`);
      router.refresh();
    });
  }

  return (
    <div style={{ borderTop: "1px solid rgba(26,26,26,0.08)", padding: "14px 0" }}>
      <div className="flex items-start gap-3 flex-wrap">
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.black }}>{p.name}</p>
          <p className="font-body" style={{ ...S.muted, marginTop: 2 }}>
            {p.wa_e164 ? showPhone(p.wa_e164) : "No WhatsApp number yet"} · {login ? `Portal login: ${loginLabel(login)}` : p.staff_id ? "Linked to a login that is switched off" : "No portal login"}
          </p>
        </div>
        <button type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing} className={`font-body ${FOCUS}`} style={sbtn("ghost")}>
          {editing ? "Hide details" : "Edit name or number"}
        </button>
      </div>
      {editing && (
        <div className="grid gap-4 md:grid-cols-3" style={{ marginTop: 12 }}>
          <div><FieldLabel htmlFor={`pname-${p.id}`}>Name</FieldLabel><input id={`pname-${p.id}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT} /></div>
          <PhoneField id={`pwa-${p.id}`} label="WhatsApp" cc={cc} local={local} onChange={(c, l) => { setCc(c); setLocal(l); }} />
          <LoginSelect id={`plogin-${p.id}`} logins={logins} value={staffId} onChange={setStaffId} />
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-x-6" style={{ marginTop: 8 }}>
        {switches(digestHour).map((s) => <Toggle key={s.k} checked={flags[s.k]} onChange={(v) => setFlags((f) => ({ ...f, [s.k]: v }))} label={<>{s.label}<span className="sr-only"> for {p.name}</span></>} />)}
      </div>
      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 10 }}>
        <button type="button" onClick={save} disabled={!dirty || pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={sbtn("dark")}>{pending ? "Saving…" : "Save"}</button>
        <button type="button" onClick={switchOff} disabled={pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={sbtn("danger")}>Switch off</button>
        {dirty && !pending && <span className="font-body" style={S.muted}>Not saved yet</span>}
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

function OffRow({ p, flash }: { p: Person; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function on() {
    if (!p.wa_e164) { setError("This person has no WhatsApp number. Add them again below."); return; }
    start(async () => {
      const r = await savePerson({ id: p.id, name: p.name, wa: p.wa_e164!, staffId: p.staff_id, on_new: p.on_new, on_change: p.on_change, on_digest: p.on_digest, on_heads_up: p.on_heads_up, active: true });
      if (!r.ok) { setError(r.error); return; }
      flash(`${p.name} is back on the list`);
      router.refresh();
    });
  }
  return (
    <div style={{ borderTop: "1px solid rgba(26,26,26,0.06)", padding: "10px 0" }}>
      <div className="flex items-center gap-3 flex-wrap">
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.softBlack }}>{p.name}</p>
          <p className="font-body" style={S.muted}>{p.wa_e164 ? showPhone(p.wa_e164) : "No WhatsApp number"}</p>
        </div>
        <button type="button" onClick={on} disabled={pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={sbtn("outline")}>{pending ? "Switching on…" : "Switch back on"}</button>
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

function LoginSelect({ id, logins, value, onChange }: { id: string; logins: Login[]; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <FieldLabel htmlFor={id}>Link to a portal login</FieldLabel>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT}>
        <option value="">No portal login</option>
        {logins.map((l) => <option key={l.id} value={l.id}>{loginLabel(l)}</option>)}
      </select>
    </div>
  );
}

function AddPerson({ logins, digestHour, flash }: { logins: Login[]; digestHour: number; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cc, setCc] = useState("+91");
  const [local, setLocal] = useState("");
  const [staffId, setStaffId] = useState("");
  const [flags, setFlags] = useState<Flags>({ on_new: true, on_change: true, on_digest: true, on_heads_up: false });
  const wa = phoneOf(cc, local);

  function add() {
    if (!name.trim()) { setError("Enter a name."); return; }
    if (!wa) { setError("That WhatsApp number does not look right. A 10-digit Indian mobile, or pick the country first."); return; }
    setError(null);
    start(async () => {
      const r = await savePerson({ name: name.trim(), wa, staffId: staffId || null, ...flags, active: true });
      if (!r.ok) { setError(r.error); return; }
      flash(`${name.trim()} added`);
      setName(""); setLocal(""); setCc("+91"); setStaffId(""); setFlags({ on_new: true, on_change: true, on_digest: true, on_heads_up: false });
      router.refresh();
    });
  }

  return (
    <div style={{ borderTop: "1px solid rgba(26,26,26,0.12)", marginTop: 8, paddingTop: 14 }}>
      <h3 className="font-body" style={S.h3}>Add a person</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <div><FieldLabel htmlFor="new-person-name">Name</FieldLabel><input id="new-person-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT} /></div>
        <PhoneField id="new-person-wa" label="WhatsApp" cc={cc} local={local} onChange={(c, l) => { setCc(c); setLocal(l); }} />
        <LoginSelect id="new-person-login" logins={logins} value={staffId}
          onChange={(v) => { setStaffId(v); const l = logins.find((x) => x.id === v); if (l && !name.trim()) setName(l.name); }} />
      </div>
      <div className="grid sm:grid-cols-2 gap-x-6" style={{ marginTop: 8 }}>
        {switches(digestHour).map((s) => <Toggle key={s.k} checked={flags[s.k]} onChange={(v) => setFlags((f) => ({ ...f, [s.k]: v }))} label={s.label} hint={s.hint} />)}
      </div>
      <button type="button" onClick={add} disabled={pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={{ ...btn("dark"), marginTop: 12 }}>{pending ? "Adding…" : "Add to the list"}</button>
      <InlineError>{error}</InlineError>
    </div>
  );
}
