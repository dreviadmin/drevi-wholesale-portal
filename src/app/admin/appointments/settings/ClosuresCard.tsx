"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { dayLabel, hm, parseHm, type Closure } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { S, btn } from "../ui";
import { removeClosure, saveClosure } from "../actions";
import { FOCUS, FieldLabel, INPUT, InlineError, Section, sbtn } from "./bits";

const what = (c: Pick<Closure, "opens" | "closes">) => (c.opens && c.closes ? `Open ${hm(parseHm(c.opens))} to ${hm(parseHm(c.closes))}` : "Closed all day");

export function ClosuresCard({ closures, today, flash }: { closures: Closure[]; today: string; flash: (m: string) => void }) {
  const router = useRouter();
  const upcoming = closures.filter((c) => c.day >= today);
  const [day, setDay] = useState("");
  const [mode, setMode] = useState<"closed" | "special">("closed");
  const [opens, setOpens] = useState("12:00");
  const [closes, setCloses] = useState("17:00");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [onDay, setOnDay] = useState<{ day: string; n: number } | null>(null);
  const [pending, start] = useTransition();
  const [removing, setRemoving] = useState<Closure | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [removePending, startRemove] = useTransition();
  const replaces = upcoming.find((c) => c.day === day);

  function add() {
    if (!day) { setError("Pick the day."); return; }
    if (day < today) { setError("Pick today or a day after."); return; }
    if (mode === "special" && (!opens || !closes || closes <= opens)) { setError("Give both times, with closing after opening."); return; }
    setError(null);
    start(async () => {
      const r = await saveClosure({ day, opens: mode === "special" ? opens : null, closes: mode === "special" ? closes : null, note: note.trim() });
      if (!r.ok) { setError(r.error); return; }
      setOnDay(r.onThatDay > 0 ? { day, n: r.onThatDay } : null);
      flash(`${dayLabel(day, today)} saved`);
      setDay(""); setNote(""); setMode("closed");
      router.refresh();
    });
  }

  function remove() {
    if (!removing) return;
    const d = removing.day;
    startRemove(async () => {
      const r = await removeClosure(d);
      if (!r.ok) { setRemoveErr(r.error); return; }
      setRemoving(null); setRemoveErr(null);
      if (onDay?.day === d) setOnDay(null);
      flash(`${dayLabel(d, today)} is back to the usual hours`);
      router.refresh();
    });
  }

  return (
    <Section id="closures" title="Closed days and special hours"
      intro="A festival, a holiday or a short day. These replace the usual opening hours for that date only. Bookings already on that day stay where they are until someone moves them.">
      {upcoming.length === 0 ? (
        <p className="font-body" style={{ ...S.body, color: palette.softBlack, marginBottom: 4 }}>No closed days or special hours coming up. Add one below.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {upcoming.map((c) => (
            <li key={c.day} className="flex items-center gap-3" style={S.row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>{dayLabel(c.day, today)}</p>
                <p className="font-body" style={S.muted}>{what(c)}{c.note ? ` · ${c.note}` : ""}</p>
              </div>
              <button type="button" onClick={() => { setRemoving(c); setRemoveErr(null); }} className={`font-body ${FOCUS}`} style={sbtn("ghost")} aria-label={`Remove ${dayLabel(c.day, today)}`}>
                <Trash2 size={15} aria-hidden /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {onDay && (
        <div role="status" className="font-body" style={{ border: "1px solid #EBD39A", background: "#FFF8E6", color: "#5A4210", fontSize: 13, padding: "10px 12px", marginTop: 12 }}>
          {onDay.n} booking{onDay.n === 1 ? " is" : "s are"} on {dayLabel(onDay.day, today)}: move {onDay.n === 1 ? "it" : "them"} from{" "}
          <Link href="/admin/appointments/all" className={FOCUS} style={{ color: "#5A4210", fontWeight: 600, textDecoration: "underline" }}>All bookings</Link>.
        </div>
      )}

      <div style={{ borderTop: "1px solid rgba(26,26,26,0.12)", marginTop: 14, paddingTop: 14 }}>
        <h3 className="font-body" style={S.h3}>Add a day</h3>
        <div className="grid gap-4 sm:grid-cols-2" style={{ maxWidth: 640 }}>
          <div>
            <FieldLabel htmlFor="closure-day" hint={replaces ? `This replaces what is set for that day (${what(replaces).toLowerCase()}).` : undefined}>Date</FieldLabel>
            <input id="closure-day" type="date" min={today} value={day} onChange={(e) => setDay(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT} />
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="font-body" style={{ ...S.label, marginBottom: 6 }}>That day</legend>
            <div className="flex flex-col">
              {(["closed", "special"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 font-body" style={{ minHeight: 44, fontSize: 13.5, color: palette.black, cursor: "pointer" }}>
                  <input type="radio" name="closure-mode" checked={mode === m} onChange={() => setMode(m)} className={FOCUS} style={{ width: 18, height: 18, accentColor: palette.black }} />
                  {m === "closed" ? "Closed all day" : "Open, with different hours"}
                </label>
              ))}
            </div>
          </fieldset>
          {mode === "special" && (
            <div className="sm:col-span-2 grid grid-cols-2 gap-3" style={{ maxWidth: 360 }}>
              <div><FieldLabel htmlFor="closure-opens">Opens</FieldLabel><input id="closure-opens" type="time" value={opens} onChange={(e) => setOpens(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT} /></div>
              <div><FieldLabel htmlFor="closure-closes">Closes</FieldLabel><input id="closure-closes" type="time" value={closes} onChange={(e) => setCloses(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT} /></div>
            </div>
          )}
          <div className="sm:col-span-2">
            <FieldLabel htmlFor="closure-note" hint="Optional, for example Diwali or Stock-taking.">Note</FieldLabel>
            <input id="closure-note" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} className={`font-body ${FOCUS}`} style={INPUT} />
          </div>
        </div>
        <button type="button" onClick={add} disabled={pending || !day} className={`font-body disabled:opacity-40 ${FOCUS}`} style={{ ...btn("dark"), marginTop: 14 }}>{pending ? "Saving…" : replaces ? "Replace this day" : "Add this day"}</button>
        <InlineError>{error}</InlineError>
      </div>

      {removing && (
        <ConfirmSheet title="Remove this day?" confirmLabel="Remove" pendingLabel="Removing…" cancelLabel="Keep it" tone="plain" pending={removePending} error={removeErr}
          onConfirm={remove} onClose={() => { if (!removePending) { setRemoving(null); setRemoveErr(null); } }}>
          {dayLabel(removing.day, today)} goes back to the usual opening hours ({what(removing).toLowerCase()} now).
        </ConfirmSheet>
      )}
    </Section>
  );
}
