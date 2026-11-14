"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PLACE_LABEL, type ApptType } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { S, TypeDot, btn } from "../ui";
import { saveType } from "../actions";
import { FOCUS, INPUT, InlineError, Section, Toggle } from "./bits";

type NumKey = "minutes" | "group_minutes" | "buffer_minutes" | "notice_hours" | "window_days";
const FIELDS: Array<{ k: NumKey; label: string; head: string; lo: number; hi: number; unit: string }> = [
  { k: "minutes", label: "Minutes", head: "Minutes", lo: 5, hi: 480, unit: "minutes" },
  { k: "group_minutes", label: "Minutes with family", head: "With family", lo: 5, hi: 480, unit: "minutes" },
  { k: "buffer_minutes", label: "Gap after (minutes)", head: "Gap after", lo: 0, hi: 120, unit: "minutes" },
  { k: "notice_hours", label: "Book at least (hours ahead)", head: "Hours ahead", lo: 0, hi: 720, unit: "hours" },
  { k: "window_days", label: "Up to (days ahead)", head: "Days ahead", lo: 1, hi: 366, unit: "days" },
];
// One grid for the header and every row from xl up; below that each type is a card.
const GRID = "xl:grid-cols-[minmax(170px,1.7fr)_repeat(5,minmax(78px,1fr))_minmax(92px,auto)_auto]";

export function TypesCard({ types, flash }: { types: ApptType[]; flash: (m: string) => void }) {
  return (
    <Section id="types" title="Appointment types"
      intro={<>How long each kind of appointment takes and how far ahead it can be booked. <b>Hours ahead</b> and <b>days ahead</b> limit the website; staff can book any time in the portal. Switching a type off takes it off the website; staff can still book it.</>}>
      {types.length === 0 ? (
        <p className="font-body" style={S.body}>No appointment types are set up yet. They come with migration 0110; ask the owner to apply it.</p>
      ) : (
        <div>
          <div className={`hidden xl:grid ${GRID} gap-2 font-body`} style={{ ...S.label, paddingBottom: 6, borderBottom: "1px solid rgba(26,26,26,0.12)" }} aria-hidden>
            <span>Type</span>
            {FIELDS.map((f) => <span key={f.k}>{f.head}</span>)}
            <span>Website</span>
            <span />
          </div>
          {types.map((t) => <TypeRow key={t.id} t={t} flash={flash} />)}
        </div>
      )}
    </Section>
  );
}

function TypeRow({ t, flash }: { t: ApptType; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const initial = { minutes: String(t.minutes), group_minutes: String(t.group_minutes), buffer_minutes: String(t.buffer_minutes), notice_hours: String(t.notice_hours), window_days: String(t.window_days) };
  const [draft, setDraft] = useState<Record<NumKey, string>>(initial);
  const [active, setActive] = useState(t.active);
  const dirty = active !== t.active || FIELDS.some((f) => draft[f.k] !== initial[f.k]);

  function save() {
    for (const f of FIELDS) {
      const v = Number(draft[f.k]);
      if (draft[f.k].trim() === "" || !Number.isInteger(v) || v < f.lo || v > f.hi) { setError(`${f.label}: a whole number from ${f.lo} to ${f.hi} ${f.unit}.`); return; }
    }
    setError(null);
    start(async () => {
      const r = await saveType(t.id, { minutes: Number(draft.minutes), group_minutes: Number(draft.group_minutes), buffer_minutes: Number(draft.buffer_minutes), notice_hours: Number(draft.notice_hours), window_days: Number(draft.window_days), active });
      if (!r.ok) { setError(r.error); return; }
      flash(`${t.name} saved`);
      router.refresh();
    });
  }

  return (
    <div style={{ borderTop: "1px solid rgba(26,26,26,0.08)", padding: "14px 0" }}>
      <div className={`grid grid-cols-2 sm:grid-cols-3 ${GRID} gap-x-3 gap-y-3 xl:gap-2 items-end xl:items-center`}>
        <div className="col-span-2 sm:col-span-3 xl:col-span-1" style={{ minWidth: 0 }}>
          <div className="flex items-center gap-2"><TypeDot typeId={t.id} /><span className="font-display" style={{ fontSize: 15, fontWeight: 600, color: palette.black }}>{t.name}</span></div>
          <p className="font-body" style={{ ...S.muted, marginTop: 2 }}>{t.places.map((p) => PLACE_LABEL[p]).join(", ")}</p>
        </div>
        {FIELDS.map((f) => (
          <label key={f.k} className="font-body block" style={{ minWidth: 0 }}>
            <span className="block xl:sr-only" style={{ ...S.label, marginBottom: 6 }}>{f.label}</span>
            <input type="number" inputMode="numeric" min={f.lo} max={f.hi} step={1} value={draft[f.k]}
              onChange={(e) => setDraft((d) => ({ ...d, [f.k]: e.target.value }))}
              aria-label={`${t.name}: ${f.label}`} className={`font-body ${FOCUS}`} style={{ ...INPUT, fontVariantNumeric: "tabular-nums" }} />
          </label>
        ))}
        <div className="col-span-2 sm:col-span-1">
          <Toggle checked={active} onChange={setActive} label={<><span className="sr-only">{t.name} on the website: </span>{active ? "On" : "Off"}</>} hint={<span className="xl:hidden">On the website</span>} />
        </div>
        <div className="col-span-2 sm:col-span-3 xl:col-span-1">
          <button type="button" onClick={save} disabled={!dirty || pending} className={`font-body disabled:opacity-40 w-full xl:w-auto ${FOCUS}`} style={btn("dark")}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}
