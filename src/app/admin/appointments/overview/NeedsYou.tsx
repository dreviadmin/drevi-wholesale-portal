// "Needs you": bookings someone has to act on. One row per booking, with every
// reason it is here. Server component.

import Link from "next/link";
import { palette } from "@/lib/palette";
import { SOURCE_LABEL, addDays, dayLabel, hm, isLive, type Appt } from "@/lib/appointments/core";
import { S, Pill } from "../ui";
import { Empty, FOCUS, dayOf, minOf, typeShort, type RowCtx } from "./parts";

type Reason = { label: string; warn: boolean };

/** Requested bookings; live ones today or tomorrow with no stylist; Google Meet calls in the next 2 days with no link. */
export function needsYouItems(appts: Appt[], ctx: RowCtx, now: Date): Array<{ a: Appt; reasons: Reason[] }> {
  const tomorrow = addDays(ctx.today, 1), in48h = now.getTime() + 48 * 3600000;
  const out: Array<{ a: Appt; reasons: Reason[] }> = [];
  for (const a of appts) {
    if (!isLive(a.status)) continue;
    const reasons: Reason[] = [], day = dayOf(a);
    if (a.status === "requested") reasons.push({ label: "Needs confirming", warn: true });
    if (!a.host_staff_id && (day === ctx.today || day === tomorrow)) reasons.push({ label: "No stylist yet", warn: false });
    if (a.place === "meet" && !a.meet_link && new Date(a.ends_at).getTime() > now.getTime() && new Date(a.starts_at).getTime() < in48h) reasons.push({ label: "No Meet link", warn: false });
    if (reasons.length) out.push({ a, reasons });
  }
  return out.sort((x, y) => x.a.starts_at.localeCompare(y.a.starts_at));
}

export function NeedsYou({ items, ctx }: { items: Array<{ a: Appt; reasons: Reason[] }>; ctx: RowCtx }) {
  return (
    <section aria-labelledby="needs-you" style={S.card}>
      <h2 id="needs-you" className="font-body" style={S.h3}>Needs you{items.length ? ` · ${items.length}` : ""}</h2>
      {items.length === 0 ? (
        <Empty>Nothing waiting. Bookings that need confirming, a stylist or a Google Meet link show up here.</Empty>
      ) : items.map(({ a, reasons }) => {
        const sub = [`${dayLabel(dayOf(a), ctx.today)}, ${hm(minOf(a))}`, typeShort(ctx.types, a.type_id), a.status === "requested" ? `via ${SOURCE_LABEL[a.source]}` : null].filter(Boolean).join(" · ");
        return (
          <Link key={a.id} href={`/admin/appointments/${encodeURIComponent(a.number)}`} className={`font-body hover:bg-[rgba(196,163,90,0.08)] ${FOCUS}`}
            style={{ ...S.row, padding: "10px 6px", textDecoration: "none", color: palette.black, alignItems: "flex-start" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{a.customer_name} <span style={{ fontWeight: 500, color: palette.mutedGreige }}>{a.number}</span></span>
              <span style={{ display: "block", fontSize: 12, color: palette.softBlack, marginTop: 2, lineHeight: 1.45 }}>{sub}</span>
            </span>
            <span className="flex flex-col items-end gap-1" style={{ flex: "none" }}>
              {reasons.map((r) => <Pill key={r.label} bg={r.warn ? "#FBEFD2" : "#E2EAF5"} fg={r.warn ? "#7A4E00" : "#274672"}>{r.label}</Pill>)}
            </span>
          </Link>
        );
      })}
    </section>
  );
}
