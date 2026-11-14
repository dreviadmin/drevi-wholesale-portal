"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { hm, type ApptSettings } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { S, btn } from "../ui";
import { saveSettings } from "../actions";
import { FOCUS, FieldLabel, INPUT, InlineError, Section } from "./bits";

const HOURS = [6, 7, 8, 9, 10, 11, 12];

export function GeneralCard({ settings, flash }: { settings: ApptSettings; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stylists, setStylists] = useState(String(settings.stylists));
  const [confirm, setConfirm] = useState<"instant" | "staff">(settings.website_confirm);
  const [digest, setDigest] = useState(settings.digest_hour);
  const dirty = stylists !== String(settings.stylists) || confirm !== settings.website_confirm || digest !== settings.digest_hour;

  function save() {
    const n = Number(stylists);
    if (!Number.isInteger(n) || n < 1 || n > 20) { setError("Stylists free for appointments: a whole number from 1 to 20."); return; }
    setError(null);
    start(async () => {
      const r = await saveSettings({ stylists: n, website_confirm: confirm, digest_hour: digest });
      if (!r.ok) { setError(r.error); return; }
      flash("General settings saved");
      router.refresh();
    });
  }

  const choice = (v: "instant" | "staff", title: string, hint: string) => (
    <label className="flex items-start gap-3 font-body" style={{ minHeight: 44, padding: "10px 12px", border: `1px solid ${confirm === v ? palette.black : "rgba(26,26,26,0.16)"}`, background: "#fff", cursor: "pointer" }}>
      <input type="radio" name="website_confirm" value={v} checked={confirm === v} onChange={() => setConfirm(v)} className={FOCUS} style={{ width: 18, height: 18, marginTop: 2, accentColor: palette.black, flex: "none" }} />
      <span style={{ fontSize: 13.5, color: palette.black }}>{title}<span className="block" style={{ ...S.muted, marginTop: 2 }}>{hint}</span></span>
    </label>
  );

  return (
    <Section id="general" title="General">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <FieldLabel htmlFor="appt-stylists" hint="How many appointments can run at the same time. A blocked stylist counts against this.">Stylists free for appointments</FieldLabel>
          <input id="appt-stylists" type="number" inputMode="numeric" min={1} max={20} step={1} value={stylists} onChange={(e) => setStylists(e.target.value)} className={`font-body ${FOCUS}`} style={{ ...INPUT, maxWidth: 140 }} />
          <p className="font-body" style={{ ...S.muted, marginTop: 8 }}>Slots start every {settings.step_minutes} minutes. This is fixed for now.</p>
        </div>
        <div>
          <FieldLabel htmlFor="appt-digest" hint="The morning WhatsApp with the day's appointments, for people who have Daily list switched on.">Daily list goes at</FieldLabel>
          <select id="appt-digest" value={digest} onChange={(e) => setDigest(Number(e.target.value))} className={`font-body ${FOCUS}`} style={{ ...INPUT, maxWidth: 180 }}>
            {HOURS.map((h) => <option key={h} value={h}>{hm(h * 60)}</option>)}
          </select>
        </div>
        <fieldset className="md:col-span-2" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="font-body" style={{ ...S.label, marginBottom: 6 }}>Bookings made on the website</legend>
          <p className="font-body" style={{ ...S.muted, marginBottom: 8 }}>The booking box on the website comes next. This decides what happens to its bookings once it is live.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {choice("instant", "Confirmed at once", "The customer gets the confirmation straight away.")}
            {choice("staff", "Staff confirm first", "They show as Needs confirming until someone calls or messages the customer.")}
          </div>
        </fieldset>
      </div>
      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 16 }}>
        <button type="button" onClick={save} disabled={!dirty || pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("dark")}>{pending ? "Saving…" : "Save"}</button>
        {dirty && !pending && <span className="font-body" style={S.muted}>Not saved yet</span>}
      </div>
      <InlineError>{error}</InlineError>
    </Section>
  );
}
