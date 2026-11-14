"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { hm, parseHm, type HoursRow } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { S, btn } from "../ui";
import { saveHours } from "../actions";
import { FOCUS, INPUT, InlineError, Section } from "./bits";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Row = { opens: string; closes: string; closed: boolean };

function rowsFrom(hours: HoursRow[]): Row[] {
  return DAYS.map((_, wd) => {
    const h = hours.find((x) => x.weekday === wd);
    return h && h.opens && h.closes ? { opens: h.opens, closes: h.closes, closed: false } : { opens: "", closes: "", closed: true };
  });
}
const same = (a: Row[], b: Row[]) => a.every((r, i) => r.closed === b[i].closed && (r.closed || (r.opens === b[i].opens && r.closes === b[i].closes)));

export function HoursCard({ hours, flash }: { hours: HoursRow[]; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const saved = rowsFrom(hours);
  const [rows, setRows] = useState<Row[]>(saved);
  const dirty = !same(rows, saved);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function save() {
    for (let i = 0; i < 7; i++) {
      const r = rows[i];
      if (r.closed) continue;
      if (!r.opens || !r.closes) { setError(`${DAYS[i]}: give both the opening and the closing time, or tick Closed.`); return; }
      if (r.closes <= r.opens) { setError(`${DAYS[i]}: closing must be after opening.`); return; }
    }
    setError(null);
    start(async () => {
      const res = await saveHours(rows.map((r, wd) => ({ weekday: wd, opens: r.closed ? null : r.opens, closes: r.closed ? null : r.closes })));
      if (!res.ok) { setError(res.error); return; }
      flash("Opening hours saved");
      router.refresh();
    });
  }

  return (
    <Section id="hours" title="Opening hours"
      intro="Appointments are only offered inside these hours, in India time. For one-off changes such as a festival or a holiday, use Closed days and special hours below.">
      <div style={{ maxWidth: 620 }}>
        {rows.map((r, i) => (
          <div key={DAYS[i]} className="grid grid-cols-[1fr_auto] sm:grid-cols-[120px_1fr_auto] items-center gap-x-3 gap-y-2" style={{ borderTop: "1px solid rgba(26,26,26,0.08)", padding: "10px 0" }}>
            <span className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>
              {DAYS[i]}
              {!r.closed && r.opens && r.closes && r.closes > r.opens && <span className="block sm:hidden" style={{ ...S.muted, fontWeight: 400 }}>{hm(parseHm(r.opens))} to {hm(parseHm(r.closes))}</span>}
            </span>
            <label className="flex items-center gap-2 font-body sm:order-last" style={{ minHeight: 44, fontSize: 13.5, color: palette.black, cursor: "pointer" }}>
              <input type="checkbox" checked={r.closed} className={FOCUS} style={{ width: 20, height: 20, accentColor: palette.black }}
                onChange={(e) => set(i, e.target.checked ? { closed: true } : { closed: false, opens: r.opens || "12:00", closes: r.closes || "20:00" })} />
              Closed
            </label>
            <div className="col-span-2 sm:col-span-1 flex items-center gap-2">
              {r.closed ? (
                <span className="font-body" style={{ ...S.muted, minHeight: 44, display: "inline-flex", alignItems: "center" }}>Closed all day, no bookings</span>
              ) : (
                <>
                  <label className="sr-only" htmlFor={`opens-${i}`}>{DAYS[i]} opens</label>
                  <input id={`opens-${i}`} type="time" value={r.opens} onChange={(e) => set(i, { opens: e.target.value })} className={`font-body ${FOCUS}`} style={{ ...INPUT, minWidth: 0 }} />
                  <span className="font-body" style={S.muted} aria-hidden>to</span>
                  <label className="sr-only" htmlFor={`closes-${i}`}>{DAYS[i]} closes</label>
                  <input id={`closes-${i}`} type="time" value={r.closes} onChange={(e) => set(i, { closes: e.target.value })} className={`font-body ${FOCUS}`} style={{ ...INPUT, minWidth: 0 }} />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 14 }}>
        <button type="button" onClick={save} disabled={!dirty || pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("dark")}>{pending ? "Saving…" : "Save hours"}</button>
        {dirty && !pending && <span className="font-body" style={S.muted}>Not saved yet</span>}
      </div>
      <InlineError>{error}</InlineError>
    </Section>
  );
}
