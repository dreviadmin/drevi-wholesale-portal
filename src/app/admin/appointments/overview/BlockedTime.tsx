"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { addDays, dayDiff, dayShort, hm, hoursFor, istParts, type Closure, type HoursRow } from "@/lib/appointments/core";
import { addBlock, removeBlock } from "../actions";
import { S, btn } from "../ui";
import { Empty, FOCUS, FieldLabel, ToastBar, dayTag, takesLabel } from "./parts";

export interface BlockRow { id: string; day: string; fromMin: number; toMin: number; takes: number; note: string | null }

const STEP = 30;
type DayMode = "today" | "tomorrow" | "other";

function timesFor(hours: HoursRow[], closures: Closure[], day: string, today: string): { closed: true; note?: string } | { closed: false; froms: number[]; open: number; close: number } {
  const h = hoursFor({ hours, closures }, day);
  if ("closed" in h) return { closed: true, note: h.note };
  let froms: number[] = [];
  for (let m = h.open; m < h.close; m += STEP) froms.push(m);
  // Today: from the half hour now running, so the time just begun can still be blocked.
  if (day === today) { const now = istParts(new Date()).min; froms = froms.filter((m) => m + STEP > now); }
  return { closed: false, froms, open: h.open, close: h.close };
}
function tosFor(from: number, close: number): number[] {
  const out: number[] = [];
  for (let m = from + STEP; m < close; m += STEP) out.push(m);
  out.push(close);
  return out;
}
const whenWord = (day: string, today: string) => { const d = dayDiff(today, day); return d === 0 ? "today" : d === 1 ? "tomorrow" : `on ${dayShort(day)}`; };

/** Blocked time today and tomorrow, with the form to block more and a remove button on each. */
export function BlockedTime({ today, blocks, hours, closures }: { today: string; blocks: BlockRow[]; hours: HoursRow[]; closures: Closure[] }) {
  const router = useRouter();
  const [toast, flash] = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DayMode>("today");
  const [other, setOther] = useState("");
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [takes, setTakes] = useState<1 | 99>(1);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BlockRow | null>(null);
  const [rmError, setRmError] = useState<string | null>(null);

  const dayFor = (m: DayMode, o: string) => (m === "today" ? today : m === "tomorrow" ? addDays(today, 1) : o);
  const day = dayFor(mode, other);
  const t = open && day ? timesFor(hours, closures, day, today) : null;

  function pickDay(m: DayMode, o: string) {
    setMode(m); setOther(o); setError(null);
    const d = dayFor(m, o), tt = d ? timesFor(hours, closures, d, today) : null;
    if (!tt || tt.closed || !tt.froms.length) { setFrom(null); setTo(null); return; }
    const f = tt.froms[0], tos = tosFor(f, tt.close);
    setFrom(f); setTo(tos.find((x) => x >= f + 60) ?? tos[tos.length - 1]);
  }
  function pickFrom(f: number) {
    setFrom(f);
    if (t && !t.closed && (to == null || to <= f)) { const tos = tosFor(f, t.close); setTo(tos.find((x) => x >= f + 60) ?? tos[tos.length - 1]); }
  }
  function openForm() { setOpen(true); setTakes(1); setNote(""); pickDay("today", ""); }

  function submit() {
    if (!day) { setError("Pick the date."); return; }
    if (from == null || to == null) { setError("Pick the start and end times."); return; }
    setError(null);
    start(async () => {
      const res = await addBlock({ day, fromMin: from, toMin: to, takes, note: note.trim() });
      if (!res.ok) { setError(res.error); return; }
      setOpen(false);
      const d = dayDiff(today, day);
      flash(`Blocked ${hm(from)} to ${hm(to)} ${whenWord(day, today)}. Those times can no longer be booked.${d > 1 ? " It shows in the Calendar." : ""}`);
      router.refresh();
    });
  }
  function remove(b: BlockRow) {
    setRmError(null);
    start(async () => {
      const res = await removeBlock(b.id);
      if (!res.ok) { setRmError(res.error); return; }
      setRemoving(null);
      flash(`${hm(b.fromMin)} to ${hm(b.toMin)} ${whenWord(b.day, today)} can be booked again.`);
      router.refresh();
    });
  }

  const select = { ...S.input, fontSize: 16, appearance: "auto" as const };
  const tos = t && !t.closed && from != null ? tosFor(from, t.close) : [];
  return (
    <section aria-labelledby="blocked-h" style={S.card}>
      <h2 id="blocked-h" className="font-body" style={S.h3}>Blocked time</h2>
      <p className="font-body" style={{ ...S.muted, margin: "-4px 0 6px", lineHeight: 1.5 }}>
        Blocked time is taken off what can be booked: a walk-in who is with a stylist, or a stylist who is off.
      </p>

      {blocks.length === 0 ? <Empty>No time blocked today or tomorrow.</Empty> : blocks.map((b) => (
        <div key={b.id} className="font-body" style={{ ...S.row, padding: "8px 0" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{dayTag(b.day, today)} · {hm(b.fromMin)} to {hm(b.toMin)}</span>
            <span style={{ display: "block", fontSize: 12, color: palette.softBlack, overflowWrap: "anywhere" }}>{takesLabel(b.takes)}{b.note ? ` · ${b.note}` : ""}</span>
          </span>
          <button type="button" onClick={() => { setRmError(null); setRemoving(b); }} className={FOCUS} style={{ ...btn("ghost", true), minHeight: 44, color: palette.crimsonText }}
            aria-label={`Remove blocked time ${hm(b.fromMin)} to ${hm(b.toMin)} ${whenWord(b.day, today)}`}>
            <Trash2 size={14} aria-hidden /> Remove
          </button>
        </div>
      ))}

      {!open ? (
        <button type="button" onClick={openForm} className={FOCUS} style={{ ...btn("outline", true), minHeight: 44, marginTop: 10 }}>
          <Plus size={14} aria-hidden /> Block time
        </button>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(26,26,26,0.12)" }}>
          <div>
            <FieldLabel htmlFor="blk-day">Day</FieldLabel>
            <select id="blk-day" value={mode} onChange={(e) => pickDay(e.target.value as DayMode, other)} className={`font-body ${FOCUS}`} style={select}>
              <option value="today">Today, {dayShort(today)}</option>
              <option value="tomorrow">Tomorrow, {dayShort(addDays(today, 1))}</option>
              <option value="other">Another day</option>
            </select>
          </div>
          {mode === "other" && (
            <div>
              <FieldLabel htmlFor="blk-date">Date</FieldLabel>
              <input id="blk-date" type="date" min={today} value={other} onChange={(e) => pickDay("other", e.target.value)} className={`font-body ${FOCUS}`} style={{ ...S.input, fontSize: 16 }} />
            </div>
          )}

          {!day ? null : t?.closed ? (
            <p className="font-body" style={{ fontSize: 13, color: palette.crimsonText, margin: 0 }}>The shop is closed that day{t.note ? ` (${t.note})` : ""}, so there is nothing to block.</p>
          ) : t && !t.froms.length ? (
            <p className="font-body" style={{ fontSize: 13, color: palette.crimsonText, margin: 0 }}>Today&apos;s opening hours are over. Pick tomorrow or another day.</p>
          ) : t ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="blk-from">From</FieldLabel>
                <select id="blk-from" value={from ?? ""} onChange={(e) => pickFrom(Number(e.target.value))} className={`font-body ${FOCUS}`} style={select}>
                  {t.froms.map((m) => <option key={m} value={m}>{hm(m)}</option>)}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="blk-to">To</FieldLabel>
                <select id="blk-to" value={to ?? ""} onChange={(e) => setTo(Number(e.target.value))} className={`font-body ${FOCUS}`} style={select}>
                  {tos.map((m) => <option key={m} value={m}>{hm(m)}</option>)}
                </select>
              </div>
            </div>
          ) : null}

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="font-body" style={{ ...S.label, marginBottom: 5 }}>What it takes</legend>
            <div className="grid grid-cols-2 gap-2">
              {([[1, "One stylist"], [99, "Whole shop"]] as const).map(([v, label]) => (
                <label key={v} className="font-body flex items-center gap-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#1A1A1A]"
                  style={{ minHeight: 44, padding: "8px 12px", fontSize: 14, cursor: "pointer", border: `1px solid ${takes === v ? palette.black : "rgba(26,26,26,0.2)"}`, background: takes === v ? palette.ivoryDeep : "#fff" }}>
                  <input type="radio" name="blk-takes" value={v} checked={takes === v} onChange={() => setTakes(v)} style={{ accentColor: palette.black }} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <FieldLabel htmlFor="blk-note">Note (optional)</FieldLabel>
            <input id="blk-note" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="Walk-in, stylist off, fitting" className={`font-body ${FOCUS}`} style={{ ...S.input, fontSize: 16 }} />
          </div>

          {error && <p role="alert" className="font-body" style={{ fontSize: 13, color: palette.crimsonText, margin: 0 }}>{error}</p>}
          <div className="flex gap-2 flex-wrap">
            <button type="submit" disabled={pending || !day || !t || t.closed || from == null || to == null} className={`disabled:opacity-40 ${FOCUS}`} style={btn("dark")}>
              {pending ? "Blocking…" : "Block this time"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setError(null); }} disabled={pending} className={FOCUS} style={btn("ghost")}>Cancel</button>
          </div>
        </form>
      )}

      {removing && (
        <ConfirmSheet title="Remove blocked time" confirmLabel="Remove" pendingLabel="Removing…" cancelLabel="Keep it" tone="plain"
          pending={pending} error={rmError} onConfirm={() => remove(removing)} onClose={() => setRemoving(null)}>
          {hm(removing.fromMin)} to {hm(removing.toMin)} {whenWord(removing.day, today)} ({takesLabel(removing.takes).toLowerCase()}) can be booked again once this is removed.
        </ConfirmSheet>
      )}
      <ToastBar message={toast} />
    </section>
  );
}
