"use client";

// Edit details. Only the fields this person actually changed are sent, so the
// history reads "Edited: name" and not a list of everything on the form. The
// form is compared with the booking as it was when the sheet opened, not the
// live one: after a "someone else changed it" refusal the page refreshes, and
// comparing with the fresh copy would send this form's older values for the
// fields the other person changed, quietly undoing their change on retry.

import { useState } from "react";
import { FUNCTIONS, PLACE_LABEL, SOURCE_LABEL, durOf, type ApptSource, type Party, type Place } from "@/lib/appointments/core";
import type { ChangeInput } from "../actions";
import { S, TypeDot } from "../ui";
import { Checkbox, Chip, FOCUS, Field, Group, PhoneField, inputStyle, phoneE164, splitPhone, type PhoneVal } from "../new/fields";
import { FormSheet } from "./FormSheet";
import { useBooking } from "./ctx";

const SOURCES: ApptSource[] = ["whatsapp", "instagram", "phone", "walkin", "website", "other"];
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function EditSheet({ onClose }: { onClose: () => void }) {
  const { appt: a, types, change, busy, errorFor } = useBooking();
  const [base] = useState(a);
  const [name, setName] = useState(a.customer_name);
  const [phone, setPhone] = useState<PhoneVal>(() => splitPhone(a.phone_e164));
  const [email, setEmail] = useState(a.email ?? "");
  const [typeId, setTypeId] = useState(a.type_id);
  const [party, setParty] = useState<Party>(a.party);
  const [place, setPlace] = useState<Place>(a.place);
  const [functions, setFunctions] = useState<string[]>(a.functions);
  const [fdate, setFdate] = useState(a.function_date ?? "");
  const [looking, setLooking] = useState(a.looking_for ?? "");
  const [notes, setNotes] = useState(a.staff_notes ?? "");
  const [notify, setNotify] = useState(a.notify_wa);
  const [source, setSource] = useState<ApptSource>(a.source);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const type = types.find((t) => t.id === typeId) ?? null;
  const e164 = phoneE164(phone);
  const lengthChanges = typeId !== base.type_id || party !== base.party;

  function diff(): NonNullable<ChangeInput["edit"]> {
    const e: NonNullable<ChangeInput["edit"]> = {};
    if (name.trim() && name.trim() !== base.customer_name) e.name = name.trim();
    if (e164 && e164 !== base.phone_e164) { e.phone = e164; e.cc = "+91"; }
    if ((email.trim() || null) !== base.email) e.email = email.trim();
    if (typeId !== base.type_id) e.typeId = typeId;
    if (party !== base.party) e.party = party;
    if (place !== base.place) e.place = place;
    if (!sameSet(functions, base.functions)) e.functions = functions;
    if ((fdate.trim() || null) !== base.function_date) e.functionDate = fdate.trim();
    if ((looking.trim() || null) !== base.looking_for) e.lookingFor = looking.trim();
    if ((notes.trim() || null) !== base.staff_notes) e.staffNotes = notes.trim();
    if (notify !== base.notify_wa) e.notifyWa = notify;
    if (source !== base.source) e.source = source;
    return e;
  }

  async function save() {
    setLocalErr(null);
    if (!name.trim()) { setLocalErr("Enter the customer's name."); return; }
    if (!e164) { setLocalErr("That WhatsApp number does not look right. A 10-digit Indian mobile, or pick the country for a number abroad."); return; }
    const edit = diff();
    if (!Object.keys(edit).length) { setLocalErr("Nothing changed."); return; }
    const ok = await change("edit", { kind: "edit", edit }, "Details saved");
    if (ok) onClose();
  }

  return (
    <FormSheet title="Edit details" confirmLabel="Save changes" pendingLabel="Saving…" pending={busy === "edit"} error={localErr ?? errorFor("edit")} onConfirm={save} onClose={onClose}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={`font-body ${FOCUS}`} style={inputStyle} />
      </Field>
      <PhoneField value={phone} onChange={setPhone} />
      <Field label="Email" optional>
        <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} className={`font-body ${FOCUS}`} style={inputStyle} />
      </Field>
      <Group label="Type">
        {types.filter((t) => t.active || t.id === a.type_id || t.id === base.type_id).map((t) => (
          <Chip key={t.id} on={typeId === t.id} onClick={() => { setTypeId(t.id); if (!t.places.includes(place)) setPlace(t.places[0]); }}><TypeDot typeId={t.id} />{t.name}</Chip>
        ))}
      </Group>
      {type ? (
        <Group label="Who is coming" hint={lengthChanges ? "This changes how long it runs. The start time stays the same." : undefined}>
          <Chip on={party === "solo"} onClick={() => setParty("solo")}>Just me · {durOf(type, "solo")} min</Chip>
          <Chip on={party === "group"} onClick={() => setParty("group")}>Me + family or friends · {durOf(type, "group")} min</Chip>
        </Group>
      ) : null}
      {type && type.places.length > 1 ? (
        <Group label="Where">
          {type.places.map((pl) => <Chip key={pl} on={place === pl} onClick={() => setPlace(pl)}>{PLACE_LABEL[pl]}</Chip>)}
        </Group>
      ) : null}
      <Group label="Functions">
        {FUNCTIONS.map((f) => <Chip key={f} on={functions.includes(f)} onClick={() => setFunctions((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]))}>{f}</Chip>)}
      </Group>
      <Field label="Function date" optional>
        <input value={fdate} onChange={(e) => setFdate(e.target.value)} maxLength={60} className={`font-body ${FOCUS}`} style={inputStyle} />
      </Field>
      <Field label="Looking for" optional hint={`${looking.length} of 600 characters.`}>
        <textarea value={looking} onChange={(e) => setLooking(e.target.value)} maxLength={600} rows={3} className={`font-body ${FOCUS}`} style={{ ...inputStyle, resize: "vertical" }} />
      </Field>
      <Field label="Notes for staff" optional hint="Only the team sees these.">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={4} className={`font-body ${FOCUS}`} style={{ ...inputStyle, resize: "vertical" }} />
      </Field>
      <div>
        <Checkbox checked={notify} onChange={setNotify}>Send them WhatsApp messages (confirmation and reminders)</Checkbox>
        {!notify && base.notify_wa ? <p className="font-body" style={S.muted}>Reminders that have not gone yet are withdrawn.</p> : null}
      </div>
      <Group label="Where they asked">
        {SOURCES.map((s) => <Chip key={s} on={source === s} onClick={() => setSource(s)}>{SOURCE_LABEL[s]}</Chip>)}
      </Group>
    </FormSheet>
  );
}
