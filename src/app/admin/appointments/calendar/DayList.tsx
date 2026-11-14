// The week as a plain day-by-day list (the phone default). No hooks.

import { palette } from "@/lib/palette";
import { dayLabel, hm, type Appt } from "@/lib/appointments/core";
import { S } from "../ui";
import { ApptRow, dayOf, minOf, takesLabel, type RowCtx } from "../overview/parts";
import type { CalBlock, CalDay } from "./CalendarView";

export function DayList({ days, appts, blocks, today, ctx }: { days: CalDay[]; appts: Appt[]; blocks: CalBlock[]; today: string; ctx: RowCtx }) {
  return (
    <div className="flex flex-col gap-3">
      {days.map((d) => {
        const items: Array<{ at: number; key: string; a?: Appt; b?: CalBlock }> = [
          ...appts.filter((a) => dayOf(a) === d.day).map((a) => ({ at: minOf(a), key: a.id, a })),
          ...blocks.filter((b) => b.day === d.day).map((b) => ({ at: b.fromMin, key: b.id, b })),
        ].sort((x, y) => x.at - y.at);
        const isToday = d.day === today;
        return (
          <section key={d.day} aria-label={dayLabel(d.day, today)} style={{ ...S.card, padding: "12px 14px", ...(isToday ? { boxShadow: `inset 3px 0 0 ${palette.gold}` } : {}) }}>
            <h3 className="font-body" style={{ fontSize: 13, fontWeight: 600, color: palette.black, margin: "0 0 4px" }}>
              {dayLabel(d.day, today)} <span style={{ fontWeight: 500, color: d.closed ? palette.crimsonText : palette.mutedGreige }}>· {d.hours}</span>
            </h3>
            {items.length === 0 ? (
              <p className="font-body" style={{ fontSize: 12.5, color: palette.mutedGreige, margin: "4px 0 0" }}>{d.closed ? "Closed. Nothing booked." : "Nothing booked."}</p>
            ) : items.map((it) => it.a ? <ApptRow key={it.key} a={it.a} ctx={ctx} /> : (
              <div key={it.key} className="font-body" style={{ ...S.row, padding: "9px 6px", color: "#4E4840", background: "rgba(122,116,107,0.08)", borderLeft: "3px solid #7A746B" }}>
                <span style={{ width: 58, flex: "none", fontSize: 13.5, fontWeight: 600 }}>{hm(it.b!.fromMin)}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflowWrap: "anywhere" }}>
                  Blocked to {hm(it.b!.toMin)} · {takesLabel(it.b!.takes)}{it.b!.note ? ` · ${it.b!.note}` : ""}
                </span>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
