"use client";

// Day chips for the next 14 days, a date field for later (up to 60 days), and
// every start time that day from slotsForDay. Full times stay on screen,
// greyed with the reason. Staff cannot pick them; an owner or admin can, and
// then sees a "book over the limit" warning (the caller sends override).

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { palette } from "@/lib/palette";
import { addDays, dayShort, dayLong, hm, hoursFor, type Closure, type HoursRow, type Party, type Place } from "@/lib/appointments/core";
import { slotsForDay } from "../actions";
import { S, btn } from "../ui";
import { FOCUS, inputStyle } from "./fields";

export interface Pick { day: string; min: number; free: boolean; why: string | null }
type SlotRow = { min: number; free: boolean; why: string | null };
type Load = { loading: boolean; error: string | null; slots: SlotRow[]; closed: boolean; note: string | null };

const SHORT_WHY: Record<string, string> = { "Both stylists are busy": "Full", "Another video call is on then": "Call on", "That stylist is busy then": "Stylist busy" };

export function SlotPicker({
  typeId, place, party, hostStaffId, exclude, today, isAdmin, hours, closures, initialDay, pick, onPick, current, reload = 0,
}: {
  typeId: string; place: Place; party: Party; hostStaffId?: string | null; exclude?: string | null;
  today: string; isAdmin: boolean; hours: HoursRow[]; closures: Closure[]; initialDay?: string;
  pick: Pick | null; onPick: (p: Pick | null) => void;
  /** The booking's own time when moving it, so it can be marked "Now". */
  current?: { day: string; min: number } | null;
  /** Bump to fetch the times again (after a booking was refused as full). */
  reload?: number;
}) {
  const [day, setDay] = useState(initialDay && initialDay >= today ? initialDay : today);
  const [load, setLoad] = useState<Load>({ loading: true, error: null, slots: [], closed: false, note: null });
  const [info, setInfo] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const dateId = useId();
  const pickRef = useRef(pick), onPickRef = useRef(onPick);
  pickRef.current = pick; onPickRef.current = onPick;

  useEffect(() => {
    if (!typeId) return;
    const n = ++req.current;
    setLoad((l) => ({ ...l, loading: true, error: null }));
    slotsForDay({ typeId, place, party, day, hostStaffId: hostStaffId || null, exclude: exclude ?? null })
      .then((res) => {
        if (n !== req.current) return;
        if (!res.ok) { setLoad({ loading: false, error: res.error, slots: [], closed: false, note: null }); return; }
        setLoad({ loading: false, error: null, slots: res.slots, closed: res.closed, note: res.note });
      })
      .catch(() => { if (n === req.current) setLoad({ loading: false, error: "Could not load the times. Check the connection and try again.", slots: [], closed: false, note: null }); });
  }, [typeId, place, party, day, hostStaffId, exclude, tick, reload]);

  // Keep the chosen time honest when the list reloads (another type, more people, a stylist picked).
  useEffect(() => {
    if (load.loading) return;
    const p = pickRef.current;
    if (!p || p.day !== day) return;
    const s = load.slots.find((x) => x.min === p.min);
    if (!s || (!s.free && !isAdmin)) { onPickRef.current(null); setInfo(`${hm(p.min)} is no longer free for this choice${s?.why ? ` (${s.why.toLowerCase()})` : ""}. Pick another time.`); }
    else if (s.free !== p.free || s.why !== p.why) onPickRef.current({ day, min: s.min, free: s.free, why: s.why });
  }, [load, day, isAdmin]);

  function chooseDay(d: string) {
    if (!d || d === day) return;
    setDay(d); setInfo(null);
    if (pickRef.current) onPick(null);
  }
  function chooseSlot(s: SlotRow) {
    if (!s.free && !isAdmin) { setInfo(`${hm(s.min)}: ${s.why ?? "Not free"}. Pick another time, or ask an owner or admin to book over the limit.`); return; }
    setInfo(null);
    onPick({ day, min: s.min, free: s.free, why: s.why });
  }

  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const lastDay = addDays(today, 60);
  const later = day > days[days.length - 1];
  const freeCount = load.slots.filter((s) => s.free).length;

  return (
    <div className="flex flex-col gap-3" style={{ minWidth: 0 }}>
      <div role="group" aria-label="Day" className="flex gap-2 overflow-x-auto" style={{ paddingBottom: 4 }}>
        {days.map((d, i) => {
          const on = d === day, h = hoursFor({ hours, closures }, d), closed = "closed" in h;
          const [dow, ...rest] = dayShort(d).split(" ");
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={`${dayLong(d)}${closed ? ", closed" : ""}`}
              onClick={() => chooseDay(d)}
              className={`font-body ${FOCUS}`}
              style={{
                flex: "0 0 auto", minWidth: i === 1 ? 84 : 66, minHeight: 56, padding: "6px 8px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
                border: `1px solid ${on ? palette.black : "rgba(26,26,26,0.2)"}`, background: on ? palette.black : closed ? "#F2EEE6" : "#fff", color: on ? palette.ivory : closed ? palette.mutedGreige : palette.black,
              }}
            >
              <span style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>{i === 0 ? "Today" : i === 1 ? "Tomorrow" : dow}</span>
              <span style={{ fontSize: 13.5 }}>{rest.join(" ")}</span>
              {closed ? <span style={{ fontSize: 9.5 }}>Closed</span> : null}
            </button>
          );
        })}
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label htmlFor={dateId} className="flex flex-col gap-1.5" style={{ minWidth: 0 }}>
          <span className="font-body" style={S.label}>A later date</span>
          <input
            id={dateId}
            type="date"
            min={today}
            max={lastDay}
            value={later ? day : ""}
            onChange={(e) => chooseDay(e.target.value && e.target.value <= lastDay ? e.target.value : day)}
            className={`font-body ${FOCUS}`}
            style={{ ...inputStyle, width: 190 }}
          />
        </label>
        <span className="font-body" style={{ ...S.muted, paddingBottom: 12 }}>Up to 60 days ahead ({dayShort(lastDay)}).</span>
      </div>

      <div className="font-body" aria-live="polite" style={{ fontSize: 13, color: palette.softBlack }}>
        <b style={{ color: palette.black }}>{dayLong(day)}</b>
        {load.loading ? " · Loading times…" : load.error ? null : load.closed ? null : load.slots.length ? ` · ${freeCount} of ${load.slots.length} times free` : null}
        {load.note && !load.closed ? <span style={{ display: "block", ...S.muted }}>Special hours: {load.note}</span> : null}
      </div>

      {load.error ? (
        <div role="alert" className="font-body flex items-center gap-3 flex-wrap" style={{ fontSize: 13, color: palette.crimsonText }}>
          {load.error}
          <button type="button" onClick={() => setTick((t) => t + 1)} className={FOCUS} style={btn("outline")}><RotateCw size={13} aria-hidden /> Try again</button>
        </div>
      ) : !load.loading && load.closed ? (
        <p className="font-body" style={{ ...S.body, color: palette.softBlack }}>The shop is closed on {dayShort(day)}{load.note ? ` (${load.note})` : ""}. Pick another day.</p>
      ) : !load.loading && !load.slots.length ? (
        <p className="font-body" style={{ ...S.body, color: palette.softBlack }}>{day === today ? "No start times left today for this length. Pick another day." : "No start time fits this day for this length. Pick another day."}</p>
      ) : (
        <div role="group" aria-label="Start time" className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2" style={{ opacity: load.loading ? 0.5 : 1 }}>
          {load.slots.map((s) => {
            const on = !!pick && pick.day === day && pick.min === s.min;
            const isNow = !!current && current.day === day && current.min === s.min;
            const short = s.why ? SHORT_WHY[s.why] ?? "Busy" : null;
            return (
              <button
                key={s.min}
                type="button"
                aria-pressed={on}
                aria-disabled={!s.free && !isAdmin ? true : undefined}
                aria-label={`${hm(s.min)}${s.free ? "" : `, ${s.why ?? "not free"}`}${isNow ? ", the current time" : ""}`}
                disabled={load.loading}
                onClick={() => chooseSlot(s)}
                className={`font-body ${FOCUS}`}
                style={{
                  minHeight: 48, padding: "5px 4px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
                  border: `1px solid ${on ? (s.free ? palette.black : palette.crimsonText) : s.free ? "rgba(26,26,26,0.2)" : "rgba(26,26,26,0.08)"}`,
                  background: on ? (s.free ? palette.black : palette.crimsonText) : s.free ? "#fff" : "#EFEBE3",
                  color: on ? palette.ivory : s.free ? palette.black : palette.mutedGreige,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, textDecoration: s.free || on ? "none" : "line-through" }}>{hm(s.min)}</span>
                {short ? <span style={{ fontSize: 10 }}>{short}</span> : isNow ? <span style={{ fontSize: 10 }}>Now</span> : null}
              </button>
            );
          })}
        </div>
      )}
      {load.slots.some((s) => !s.free) && !load.loading ? (
        <p className="font-body" style={S.muted}>
          Greyed times are taken: {[...new Set(load.slots.filter((s) => !s.free).map((s) => s.why ?? "not free"))].map((w) => `${SHORT_WHY[w] ?? "Busy"} means ${w.charAt(0).toLowerCase()}${w.slice(1)}`).join("; ")}.
          {isAdmin ? " As an owner or admin you can still pick one." : ""}
        </p>
      ) : null}
      {info ? <p role="status" className="font-body" style={{ fontSize: 13, color: palette.crimsonText }}>{info}</p> : null}
      {pick && pick.day === day && !pick.free ? <OverLimit pick={pick} /> : null}
    </div>
  );
}

export function OverLimit({ pick }: { pick: Pick }) {
  return (
    <div role="alert" className="font-body flex gap-2" style={{ border: `1px solid ${palette.crimsonBorder}`, background: palette.crimsonSoft, color: palette.crimsonText, padding: "10px 12px", fontSize: 13, lineHeight: 1.5 }}>
      <AlertTriangle size={16} aria-hidden style={{ flex: "none", marginTop: 2 }} />
      <span><b>Book over the limit.</b> {pick.why ?? "That time is taken"} at {hm(pick.min)} on {dayShort(pick.day)}. Saving books it anyway, so the shop is double-booked then. Only do this if the team can cover it.</span>
    </div>
  );
}
