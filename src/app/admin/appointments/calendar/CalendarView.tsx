"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { palette } from "@/lib/palette";
import { addDays, dayShort, istParts, type Appt, type ApptType } from "@/lib/appointments/core";
import { TypeDot, btn } from "../ui";
import { FOCUS, staffMap, type StaffLite } from "../overview/parts";
import { WeekGrid } from "./WeekGrid";
import { DayList } from "./DayList";

export type CalDay = { day: string; closed: true; hours: string } | { day: string; closed: false; open: number; close: number; hours: string };
export interface CalBlock { id: string; day: string; fromMin: number; toMin: number; takes: number; note: string | null }

type View = "week" | "list";
const VIEW_KEY = "drevi.appointments.calendarView";
const BASE = "/admin/appointments/calendar";

export function CalendarView({ start, today, nowIso, prevStart, nextStart, days, appts, blocks, h0, h1, types, staff }: {
  start: string; today: string; nowIso: string; prevStart: string; nextStart: string;
  days: CalDay[]; appts: Appt[]; blocks: CalBlock[]; h0: number; h1: number; types: ApptType[]; staff: StaffLite[];
}) {
  // null until mounted: the CSS shows the list under 768px and the grid above,
  // then the viewer's own choice (kept on this device) or the width decides.
  const [view, setView] = useState<View | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [now, setNow] = useState(nowIso);

  useEffect(() => {
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(VIEW_KEY); } catch { /* storage blocked: fall back to width */ }
    setView(saved === "week" || saved === "list" ? saved : window.matchMedia("(min-width: 768px)").matches ? "week" : "list");
    const t = setInterval(() => setNow(new Date().toISOString()), 60000);
    return () => clearInterval(t);
  }, []);
  function choose(v: View) {
    setView(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* fine: just not remembered */ }
  }

  const ctx = useMemo(() => ({ types, staff: staffMap(staff), today }), [types, staff, today]);
  const cancelled = appts.filter((a) => a.status === "cancelled").length;
  const shown = showCancelled ? appts : appts.filter((a) => a.status !== "cancelled");
  const nowP = istParts(now);
  const nowMin = nowP.day === today ? nowP.min : null;
  const isThisWeek = start === today;

  const seg = (on: boolean) => ({ ...btn(on ? "dark" : "outline", true), minHeight: 44 });
  return (
    <div style={{ minWidth: 0 }}>
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 10 }}>
        <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black, margin: 0, flex: "1 1 auto", minWidth: 200 }}>
          {dayShort(start)} to {dayShort(addDays(start, 6))}
        </h2>
        <nav aria-label="Weeks" className="flex gap-1.5">
          <Link href={`${BASE}?start=${prevStart}`} aria-label="Previous week" className={FOCUS} style={{ ...btn("outline", true), minHeight: 44, minWidth: 44, padding: "6px 10px" }}><ChevronLeft size={16} aria-hidden /></Link>
          <Link href={BASE} aria-current={isThisWeek ? "page" : undefined} className={FOCUS} style={{ ...btn(isThisWeek ? "dark" : "outline", true), minHeight: 44 }}>This week</Link>
          <Link href={`${BASE}?start=${nextStart}`} aria-label="Next week" className={FOCUS} style={{ ...btn("outline", true), minHeight: 44, minWidth: 44, padding: "6px 10px" }}><ChevronRight size={16} aria-hidden /></Link>
        </nav>
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 12 }}>
        <div role="group" aria-label="How to show the week" className="flex">
          <button type="button" onClick={() => choose("week")} aria-pressed={view === "week"} className={FOCUS} style={seg(view === "week")}>Week grid</button>
          <button type="button" onClick={() => choose("list")} aria-pressed={view === "list"} className={FOCUS} style={{ ...seg(view === "list"), marginLeft: -1 }}>Day by day</button>
        </div>
        <button type="button" onClick={() => setShowCancelled((v) => !v)} aria-pressed={showCancelled} disabled={cancelled === 0} className={`disabled:opacity-40 ${FOCUS}`} style={seg(showCancelled)}>
          {showCancelled ? "Hide cancelled" : "Show cancelled"} · {cancelled}
        </button>
      </div>

      {shown.length === 0 && (
        <p className="font-body" style={{ fontSize: 13, color: palette.mutedGreige, margin: "0 0 10px" }}>
          Nothing booked this week{cancelled && !showCancelled ? " (cancelled ones are hidden)" : ""}. Use New appointment to book someone in, or look at another week.
        </p>
      )}

      <div className={view === null ? "hidden md:block" : view === "week" ? "block" : "hidden"}>
        <WeekGrid days={days} appts={shown} blocks={blocks} h0={h0} h1={h1} today={today} nowMin={nowMin} ctx={ctx} />
        <div className="font-body flex flex-wrap gap-x-4 gap-y-1.5" style={{ fontSize: 12, color: palette.mutedGreige, marginTop: 10 }}>
          {types.map((t) => <span key={t.id} className="flex items-center gap-1.5"><TypeDot typeId={t.id} /> {t.name}</span>)}
          <span>Dashed outline: needs confirming</span>
          <span>Grey bar: blocked time</span>
          <span>Striped: closed</span>
          <span>Red line: now</span>
        </div>
      </div>
      <div className={view === null ? "md:hidden" : view === "list" ? "block" : "hidden"}>
        <DayList days={days} appts={shown} blocks={blocks} today={today} ctx={ctx} />
      </div>
    </div>
  );
}
