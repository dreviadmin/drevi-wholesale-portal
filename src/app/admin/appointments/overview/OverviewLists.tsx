"use client";

import { useMemo, useState } from "react";
import { palette } from "@/lib/palette";
import { addDays, dayLabel, dayShort, type Appt, type ApptType } from "@/lib/appointments/core";
import { S, btn } from "../ui";
import { ApptRow, Empty, FOCUS, FieldLabel, dayOf, isFinished, staffMap, type StaffLite } from "./parts";
import { CopyToday } from "./CopyToday";

/**
 * Today's list and the next six days, with one filter row for both. A stylist
 * starts on "Mine and unassigned"; owners and admins start on every stylist.
 */
export function OverviewLists({ today, appts, types, staff, meId, mineFirst, dayHours, copyText, copyCount }: {
  today: string;
  /** Today through six days ahead, cancelled ones already left out. */
  appts: Appt[];
  types: ApptType[];
  staff: StaffLite[];
  meId: string;
  mineFirst: boolean;
  /** "Open 12 pm to 8 pm" or "Closed" for each of the seven days. */
  dayHours: Record<string, string>;
  copyText: string;
  copyCount: number;
}) {
  const [fType, setFType] = useState("all");
  const [fHost, setFHost] = useState(mineFirst ? "mine" : "all");
  const [hideFinished, setHideFinished] = useState(false);
  const ctx = useMemo(() => ({ types, staff: staffMap(staff), today }), [types, staff, today]);

  const match = (a: Appt) => {
    if (fType !== "all" && a.type_id !== fType) return false;
    if (fHost === "mine") return a.host_staff_id === meId || !a.host_staff_id;
    if (fHost === "none") return !a.host_staff_id;
    if (fHost !== "all") return a.host_staff_id === fHost;
    return true;
  };
  const todayAll = appts.filter((a) => dayOf(a) === today);
  const todayMatch = todayAll.filter(match);
  const finishedCount = todayMatch.filter((a) => isFinished(a.status)).length;
  const todayShown = hideFinished ? todayMatch.filter((a) => !isFinished(a.status)) : todayMatch;
  const filtersOn = fType !== "all" || fHost !== "all";
  const reset = () => { setFType("all"); setFHost("all"); setHideFinished(false); };
  const upcoming = [1, 2, 3, 4, 5, 6].map((i) => addDays(today, i));

  // 16px so iPhones do not zoom the page when a select opens.
  const select = { ...S.input, fontSize: 16, appearance: "auto" as const };
  return (
    <div className="flex flex-col gap-4" style={{ minWidth: 0 }}>
      <section id="today" aria-labelledby="today-h" style={{ ...S.card, scrollMarginTop: 16 }}>
        <div className="flex items-start gap-3 flex-wrap" style={{ marginBottom: 10 }}>
          <h2 id="today-h" className="font-body" style={{ ...S.h3, margin: 0, flex: 1, minWidth: 180, lineHeight: 1.6 }}>
            Today · {dayShort(today)} · {dayHours[today]}
          </h2>
          {copyCount > 0 && <CopyToday text={copyText} count={copyCount} />}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end" style={{ marginBottom: 6 }}>
          <div>
            <FieldLabel htmlFor="ov-type">Type</FieldLabel>
            <select id="ov-type" value={fType} onChange={(e) => setFType(e.target.value)} className={`font-body ${FOCUS}`} style={select}>
              <option value="all">All types</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="ov-host">Stylist</FieldLabel>
            <select id="ov-host" value={fHost} onChange={(e) => setFHost(e.target.value)} className={`font-body ${FOCUS}`} style={select}>
              <option value="all">Every stylist</option>
              <option value="mine">Mine and unassigned</option>
              <option value="none">No stylist yet</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === meId ? " (me)" : ""}</option>)}
            </select>
          </div>
          <button type="button" onClick={() => setHideFinished((v) => !v)} aria-pressed={hideFinished} className={FOCUS}
            style={{ ...btn(hideFinished ? "dark" : "outline", true), minHeight: 44 }}>
            {hideFinished ? "Show finished" : "Hide finished"}{finishedCount ? ` · ${finishedCount}` : ""}
          </button>
        </div>

        {todayShown.length ? todayShown.map((a) => <ApptRow key={a.id} a={a} ctx={ctx} />) : todayAll.length === 0 ? (
          <Empty>No appointments today. For a walk-in or someone who rang, tap New appointment.</Empty>
        ) : (
          <Empty action={<button type="button" onClick={reset} className={FOCUS} style={{ ...btn("outline", true), minHeight: 44 }}>Show every appointment</button>}>
            {todayAll.length} appointment{todayAll.length === 1 ? " is" : "s are"} on today, but none match {filtersOn ? "these filters" : "while finished ones are hidden"}.
          </Empty>
        )}
      </section>

      <section aria-labelledby="coming-h" style={S.card}>
        <h2 id="coming-h" className="font-body" style={S.h3}>Coming up</h2>
        {upcoming.map((d) => {
          const dayAll = appts.filter((a) => dayOf(a) === d), list = dayAll.filter(match);
          const closed = dayHours[d]?.startsWith("Closed");
          return (
            <div key={d} style={{ marginTop: 6 }}>
              <h3 className="font-body" style={{ fontSize: 12.5, fontWeight: 600, color: palette.black, padding: "10px 0 2px", margin: 0, borderTop: "1px solid rgba(26,26,26,0.12)" }}>
                {dayLabel(d, today)} <span style={{ fontWeight: 500, color: closed ? palette.crimsonText : palette.mutedGreige }}>· {dayHours[d]}</span>
              </h3>
              {list.length ? list.map((a) => <ApptRow key={a.id} a={a} ctx={ctx} />) : (
                <p className="font-body" style={{ fontSize: 12.5, color: palette.mutedGreige, margin: "2px 0 6px" }}>{dayAll.length ? `${dayAll.length} booked, none that match the filters.` : "Nothing booked."}</p>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
