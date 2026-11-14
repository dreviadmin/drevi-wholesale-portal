// The 7-day week grid: hours down the side, one column a day, each booking a
// coloured block placed by its India-time start and length. No hooks: the
// CalendarView owns the state and passes what to draw.

import Link from "next/link";
import type { CSSProperties } from "react";
import { palette } from "@/lib/palette";
import { PLACE_LABEL, STATUS_LABEL, dayShort, firstName, hm, type Appt } from "@/lib/appointments/core";
import { TYPE_COLOR } from "../ui";
import { FOCUS, dayOf, hostLabel, isFinished, minOf, minutesOf, takesLabel, typeShort, type RowCtx } from "../overview/parts";
import type { CalBlock, CalDay } from "./CalendarView";
import { lanes } from "./lanes";

export const ROW = 44; // px per hour
const STRIPES = "repeating-linear-gradient(135deg, #F4F0E8 0 6px, #EAE3D5 6px 12px)";
const LINES = `repeating-linear-gradient(to bottom, rgba(26,26,26,0.08) 0 1px, transparent 1px ${ROW}px)`;

function look(a: Appt): CSSProperties {
  const c = TYPE_COLOR[a.type_id] ?? palette.mutedGreige;
  if (a.status === "cancelled") return { background: "#ECE9E4", color: "#7A746B", border: "1px solid #D8D2C8", textDecoration: "line-through" };
  if (a.status === "requested") return { background: `linear-gradient(${c}22, ${c}22), #fff`, color: c, border: `2px dashed ${c}` };
  return { background: c, color: "#fff", border: `1px solid ${c}`, opacity: isFinished(a.status) ? 0.6 : 1 };
}

export function WeekGrid({ days, appts, blocks, h0, h1, today, nowMin, ctx }: {
  days: CalDay[]; appts: Appt[]; blocks: CalBlock[]; h0: number; h1: number; today: string; nowMin: number | null; ctx: RowCtx;
}) {
  const height = ((h1 - h0) / 60) * ROW;
  const y = (min: number) => ((min - h0) / 60) * ROW;
  const hourMarks: number[] = [];
  for (let m = h0; m < h1; m += 60) hourMarks.push(m);
  const head: CSSProperties = { padding: "8px 6px", borderBottom: "1px solid rgba(26,26,26,0.12)", minHeight: 52 };

  return (
    <div className="overflow-x-auto" role="region" aria-label="Week grid, scrolls sideways" tabIndex={0} style={{ border: "1px solid rgba(26,26,26,0.12)", background: "#fff" }}>
      <div className="font-body" style={{ display: "grid", gridTemplateColumns: "56px repeat(7, minmax(100px, 1fr))", minWidth: 56 + 7 * 100 }}>
        <div style={head} />
        {days.map((d) => {
          const isToday = d.day === today;
          return (
            <div key={d.day} style={{ ...head, borderLeft: "1px solid rgba(26,26,26,0.08)", background: isToday ? palette.ivoryDeep : undefined, boxShadow: isToday ? `inset 0 3px 0 ${palette.gold}` : undefined }}>
              <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: palette.black }}>{isToday ? "Today" : dayShort(d.day).split(" ")[0]} {dayShort(d.day).split(" ").slice(1).join(" ")}</span>
              <span style={{ display: "block", fontSize: 10.5, lineHeight: 1.35, color: d.closed ? palette.crimsonText : palette.mutedGreige }}>{d.hours.replace(/^Open /, "")}</span>
            </div>
          );
        })}

        <div aria-hidden style={{ position: "relative", height }}>
          {hourMarks.map((m) => <span key={m} style={{ position: "absolute", top: y(m) + 2, right: 6, fontSize: 10.5, color: palette.mutedGreige, whiteSpace: "nowrap" }}>{hm(m)}</span>)}
        </div>

        {days.map((d) => {
          const mine = appts.filter((a) => dayOf(a) === d.day);
          const lane = lanes(mine.map((a) => { const s = minOf(a); return { id: a.id, s, e: Math.max(s + minutesOf(a), s + 30) }; }));
          const showNow = d.day === today && nowMin != null && nowMin >= h0 && nowMin <= h1;
          return (
            <div key={d.day} style={{ position: "relative", height, borderLeft: "1px solid rgba(26,26,26,0.08)", background: d.closed ? STRIPES : undefined }}>
              {!d.closed && d.open > h0 && <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: y(d.open), background: STRIPES }} />}
              {!d.closed && d.close < h1 && <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: y(d.close), bottom: 0, background: STRIPES }} />}
              <div aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: LINES, pointerEvents: "none" }} />

              {blocks.filter((b) => b.day === d.day).map((b) => (
                <div key={b.id} aria-hidden title={`Blocked ${hm(b.fromMin)} to ${hm(b.toMin)} · ${takesLabel(b.takes)}${b.note ? ` · ${b.note}` : ""}`}
                  style={{ position: "absolute", left: 0, right: 0, top: y(b.fromMin), height: Math.max(14, y(b.toMin) - y(b.fromMin)), zIndex: 1, background: "rgba(122,116,107,0.18)", borderLeft: "3px solid #7A746B", padding: "1px 4px", fontSize: 10, lineHeight: "13px", color: "#4E4840", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  Blocked · {b.takes >= 99 ? "whole shop" : takesLabel(b.takes).toLowerCase()}{b.note ? ` · ${b.note}` : ""}
                </div>
              ))}

              {mine.map((a) => {
                const s = minOf(a), dur = minutesOf(a), l = lane.get(a.id) ?? { i: 0, n: 1 };
                const h = Math.max(22, (dur / 60) * ROW - 2);
                const label = `${hm(s)} to ${hm(s + dur)}, ${a.customer_name}, ${typeShort(ctx.types, a.type_id)}, ${PLACE_LABEL[a.place]}, ${hostLabel(ctx.staff, a.host_staff_id)}, ${STATUS_LABEL[a.status]}`;
                return (
                  <Link key={a.id} href={`/admin/appointments/${encodeURIComponent(a.number)}`} aria-label={label} title={label} className={`hover:brightness-95 ${FOCUS}`}
                    style={{ position: "absolute", top: y(s) + 1, height: h, left: `calc(${(l.i / l.n) * 100}% + 2px)`, width: `calc(${100 / l.n}% - 4px)`, zIndex: 2, overflow: "hidden", padding: "2px 5px", fontSize: 11, lineHeight: "15px", textDecoration: "none", ...look(a) }}>
                    <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b>{hm(s)}</b> {firstName(a.customer_name)}</span>
                    {h >= 34 && <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.92 }}>{typeShort(ctx.types, a.type_id)}</span>}
                  </Link>
                );
              })}

              {showNow && (
                <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: y(nowMin!), zIndex: 3, borderTop: "2px solid #8C2331", pointerEvents: "none" }}>
                  <span style={{ position: "absolute", left: -4, top: -5, width: 8, height: 8, borderRadius: "50%", background: "#8C2331" }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
