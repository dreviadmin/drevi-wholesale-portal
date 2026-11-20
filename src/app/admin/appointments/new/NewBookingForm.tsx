"use client";

// New appointment. One form, four parts: the customer, the appointment, what
// they told us, and what happens when it is saved. The idempotency key is a
// random part made once per form plus the day, time, number and type, so a
// double tap (or a retry after a dropped connection) with the same details
// books once, while a retry with a changed time, customer or type is a new
// booking instead of quietly getting the earlier one back.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";
import {
  FUNCTIONS, PLACE_LABEL, SOURCE_LABEL, durOf, fromIst, type Appt, type ApptSource, type ApptType, type Closure, type HoursRow, type Party, type Place,
} from "@/lib/appointments/core";
import { bookAppointment } from "../actions";
import { S, TypeDot, btn } from "../ui";
import { findCustomer, type EarlierCustomer } from "./actions-booking";
import { Checkbox, Chip, EMPTY_PHONE, ErrorNote, FOCUS, Field, Group, PhoneField, SECTION, inputStyle, newKey, phoneE164, type PhoneVal } from "./fields";
import { SlotPicker, type Pick } from "./SlotPicker";
import { EarlierBookings } from "./EarlierBookings";
import { ConfirmPreview } from "./ConfirmPreview";

const ASKED: ApptSource[] = ["whatsapp", "instagram", "phone", "walkin", "other"];

/** The per-form random part plus the details that make it this booking, at most 80 characters of [A-Za-z0-9_-]. */
function bookingKey(base: string, pick: Pick, e164: string, typeId: string): string {
  const clean = (x: string) => x.replace(/[^A-Za-z0-9_-]/g, "-");
  const details = clean(`${pick.day}-${pick.min}-${e164.replace(/\D/g, "").slice(-10)}-${typeId}`).slice(0, 56);
  return `${clean(base).slice(0, 79 - details.length)}-${details}`;
}

export interface NewBookingProps {
  types: ApptType[]; hours: HoursRow[]; closures: Closure[]; staff: Array<{ id: string; name: string }>;
  isAdmin: boolean; today: string; automationOn: boolean; testMode: boolean; initialDay?: string; initialType?: string;
}

export function NewBookingForm(p: NewBookingProps) {
  const router = useRouter();
  const [keyBase] = useState(newKey);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Customer
  const [phone, setPhone] = useState<PhoneVal>(EMPTY_PHONE);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState<ApptSource>("whatsapp");
  const [found, setFound] = useState<EarlierCustomer | null>(null);

  // Appointment
  const firstType = p.types.find((t) => t.id === p.initialType) ?? p.types[0];
  const [typeId, setTypeId] = useState(firstType?.id ?? "");
  const type = p.types.find((t) => t.id === typeId) ?? null;
  const [party, setParty] = useState<Party>("solo");
  const [place, setPlace] = useState<Place>(firstType?.places[0] ?? "store");
  const [pick, setPick] = useState<Pick | null>(null);
  const [host, setHost] = useState("");

  // What they told us
  const [functions, setFunctions] = useState<string[]>([]);
  const [fdate, setFdate] = useState("");
  const [looking, setLooking] = useState("");
  const [notes, setNotes] = useState("");
  const [meet, setMeet] = useState("");

  // When you save
  const [status, setStatus] = useState<"confirmed" | "requested">("confirmed");
  const [notify, setNotify] = useState(true);

  const e164 = phoneE164(phone);

  // Earlier bookings for this number, once it is a whole number.
  useEffect(() => {
    setFound(null);
    if (!e164 || e164.replace(/\D/g, "").length < 10) return;
    let live = true;
    const t = setTimeout(() => {
      findCustomer(e164).then((r) => { if (live && r.ok) setFound(r.found); }).catch(() => { /* the lookup is a convenience; booking still works */ });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [e164]);

  function chooseType(t: ApptType) {
    setTypeId(t.id);
    if (!t.places.includes(place)) setPlace(t.places[0]);
  }

  const meetBad = place === "meet" && meet.trim() !== "" && !/^https:\/\/\S+$/.test(meet.trim());
  const missing = [
    !e164 && "a WhatsApp number that looks right",
    !name.trim() && "the customer's name",
    !type && "the type",
    !pick && "a time",
    meetBad && "a Meet link starting with https://",
  ].filter(Boolean) as string[];
  const override = !!pick && !pick.free && p.isAdmin;

  const draft: Appt | null = useMemo(() => {
    if (!type || !pick || !e164 || !name.trim()) return null;
    const s = fromIst(pick.day, pick.min), e = new Date(s.getTime() + durOf(type, party) * 60000), now = new Date().toISOString();
    return {
      id: "", number: "A-…", type_id: type.id, place, party, starts_at: s.toISOString(), ends_at: e.toISOString(), status, source, customer_name: name.trim(), phone_e164: e164,
      email: email.trim() || null, functions, function_date: fdate.trim() || null, looking_for: looking.trim() || null, staff_notes: null,
      meet_link: place === "meet" && meet.trim() && !meetBad ? meet.trim() : null, host_staff_id: host || null, notify_wa: notify, notify_email: false, offers_ok: false,
      outcome: null, cancel_reason: null, manage_token: "", created_by: null, created_at: now, confirmed_at: null, cancelled_at: null, updated_at: now, rev: 1,
    };
  }, [type, pick, e164, name, place, party, status, source, email, functions, fdate, looking, meet, meetBad, host, notify]);

  function save() {
    setError(null);
    if (missing.length || !pick || !type || !e164) { setError(`Still needed: ${missing.join(", ")}.`); return; }
    const key = bookingKey(keyBase, pick, e164, type.id);
    start(async () => {
      try {
        const res = await bookAppointment({
          typeId: type.id, place, party, day: pick.day, min: pick.min, status, source, name: name.trim(), phone: e164, cc: "+91",
          email: email.trim(), functions, functionDate: fdate.trim(), lookingFor: looking.trim(), staffNotes: notes.trim(),
          meetLink: place === "meet" ? meet.trim() : "", hostStaffId: host || null, notifyWa: notify, override, idempotencyKey: key,
        });
        if (!res.ok) { setError(res.error); setReload((r) => r + 1); return; }
        router.push(`/admin/appointments/${res.number}`);
      } catch {
        setError("Could not reach the server. Check the connection and tap Book again; it will not book twice.");
      }
    });
  }

  if (!p.types.length) {
    return <p className="font-body" style={{ ...S.card, ...S.body }}>No appointment types are switched on. An owner or admin can switch them on in Appointments, Settings.</p>;
  }

  const applied = !!found && name.trim() === found.name && (!found.email || email.trim() === found.email);

  return (
    <form className="flex flex-col gap-4" style={{ maxWidth: 760 }} onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
      <section style={SECTION} aria-labelledby="sec-customer">
        <h2 id="sec-customer" className="font-body" style={{ ...S.h3, margin: 0 }}>Customer</h2>
        <PhoneField value={phone} onChange={setPhone} />
        {found ? (
          <EarlierBookings found={found} applied={applied} typeName={(id) => p.types.find((t) => t.id === id)?.name ?? id}
            onUse={() => { setName(found.name); if (found.email) setEmail(found.email); }} />
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" className={`font-body ${FOCUS}`} style={inputStyle} />
          </Field>
          <Field label="Email" optional>
            <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" className={`font-body ${FOCUS}`} style={inputStyle} />
          </Field>
        </div>
        <Group label="They asked on">
          {ASKED.map((s) => <Chip key={s} on={source === s} onClick={() => setSource(s)}>{SOURCE_LABEL[s]}</Chip>)}
        </Group>
      </section>

      <section style={SECTION} aria-labelledby="sec-appt">
        <h2 id="sec-appt" className="font-body" style={{ ...S.h3, margin: 0 }}>Appointment</h2>
        <Group label="Type">
          {p.types.map((t) => <Chip key={t.id} on={typeId === t.id} onClick={() => chooseType(t)}><TypeDot typeId={t.id} />{t.name}</Chip>)}
        </Group>
        {type ? (
          <Group label="Who is coming">
            <Chip on={party === "solo"} onClick={() => setParty("solo")}>Just me · {durOf(type, "solo")} min</Chip>
            <Chip on={party === "group"} onClick={() => setParty("group")}>Me + family or friends · {durOf(type, "group")} min</Chip>
          </Group>
        ) : null}
        {type && type.places.length > 1 ? (
          <Group label="Where">
            {type.places.map((pl) => <Chip key={pl} on={place === pl} onClick={() => setPlace(pl)}>{PLACE_LABEL[pl]}</Chip>)}
          </Group>
        ) : null}
        <Field label="Stylist" hint="Picking a stylist hides the times they are already busy.">
          <select value={host} onChange={(e) => setHost(e.target.value)} className={`font-body ${FOCUS}`} style={inputStyle}>
            <option value="">Decide later</option>
            {p.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        {type ? (
          <div className="flex flex-col gap-2" style={{ minWidth: 0 }}>
            <span className="font-body" style={S.label}>Day and time</span>
            <SlotPicker typeId={type.id} place={place} party={party} hostStaffId={host || null} today={p.today} isAdmin={p.isAdmin}
              hours={p.hours} closures={p.closures} initialDay={p.initialDay} pick={pick} onPick={setPick} reload={reload} />
          </div>
        ) : null}
      </section>

      <section style={SECTION} aria-labelledby="sec-told">
        <h2 id="sec-told" className="font-body" style={{ ...S.h3, margin: 0 }}>What they told us</h2>
        <Group label="Functions">
          {FUNCTIONS.map((f) => (
            <Chip key={f} on={functions.includes(f)} onClick={() => setFunctions((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]))}>{f}</Chip>
          ))}
        </Group>
        <Field label="Function date" optional hint="A date or a rough time, like 12 December or mid-January.">
          <input value={fdate} onChange={(e) => setFdate(e.target.value)} maxLength={60} className={`font-body ${FOCUS}`} style={inputStyle} />
        </Field>
        <Field label="Looking for" optional hint={`${looking.length} of 600 characters. Goes in the staff alert, not to the customer.`}>
          <textarea value={looking} onChange={(e) => setLooking(e.target.value)} maxLength={600} rows={3} className={`font-body ${FOCUS}`} style={{ ...inputStyle, resize: "vertical" }} />
        </Field>
        <Field label="Notes for staff" optional hint="Only the team sees these. Never sent to the customer.">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} className={`font-body ${FOCUS}`} style={{ ...inputStyle, resize: "vertical" }} />
        </Field>
        {place === "meet" ? (
          <Field label="Google Meet link" optional hint={meetBad ? <span style={{ color: palette.crimsonText }}>The link must start with https://</span> : "You can add it later on the booking page. It goes in the confirmation."}>
            <input type="url" inputMode="url" value={meet} onChange={(e) => setMeet(e.target.value)} maxLength={300} placeholder="https://meet.google.com/…" className={`font-body ${FOCUS}`} style={inputStyle} />
          </Field>
        ) : null}
      </section>

      <section style={SECTION} aria-labelledby="sec-save">
        <h2 id="sec-save" className="font-body" style={{ ...S.h3, margin: 0 }}>When you save</h2>
        <Group label="Status" hint={status === "requested" ? "It shows as Needs confirming until someone confirms it. The customer hears nothing until then." : undefined}>
          <Chip on={status === "confirmed"} onClick={() => setStatus("confirmed")}>Confirmed</Chip>
          <Chip on={status === "requested"} onClick={() => setStatus("requested")}>Pencil it in (needs confirming)</Chip>
        </Group>
        <div>
          <Checkbox checked={notify} onChange={setNotify}>Send them WhatsApp messages (confirmation and reminders)</Checkbox>
          <p className="font-body" style={{ ...S.muted, marginTop: -2 }}>
            {!p.automationOn
              ? "Automatic messages are off right now, so nothing goes out on its own. Send the confirmation from the booking page with Send the confirmation."
              : p.testMode ? "Test mode is on: automatic messages go only to the test numbers in Settings." : "The confirmation goes out on save, then a reminder the day before and 2 hours before."}
          </p>
        </div>
        {draft && type ? <ConfirmPreview draft={draft} types={p.types} status={status} notify={notify} automationOn={p.automationOn} testMode={p.testMode} /> : null}
      </section>

      <div className="flex flex-col gap-3" style={{ paddingBottom: 24 }}>
        <ErrorNote>{error}</ErrorNote>
        {missing.length && !error ? <p className="font-body" style={S.muted}>Still needed: {missing.join(", ")}.</p> : null}
        <div className="flex gap-3 flex-wrap">
          <button type="submit" disabled={pending} className={`disabled:opacity-50 ${FOCUS}`} style={{ ...btn(override ? "danger" : "dark"), ...(override ? { background: palette.crimsonText, color: palette.ivory } : {}), minWidth: 200, minHeight: 48 }}>
            {pending ? "Booking…" : override ? "Book over the limit" : status === "requested" ? "Pencil it in" : "Book appointment"}
          </button>
        </div>
      </div>
    </form>
  );
}
