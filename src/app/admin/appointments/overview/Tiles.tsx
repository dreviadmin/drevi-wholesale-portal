// The four counts across the top of the Overview. Shop-wide (the filters below
// narrow the lists, not these). Server component.

import Link from "next/link";
import { palette } from "@/lib/palette";
import { S } from "../ui";
import { FOCUS } from "./parts";

export interface TileCounts {
  today: number; toCome: number; here: number; finished: number;
  tomorrow: number; tomorrowVideo: number; tomorrowStore: number;
  week: number; weekWebsite: number;
  requested: number;
}

function Tile({ href, k, v, d, alert = false }: { href: string; k: string; v: number; d: string; alert?: boolean }) {
  return (
    <Link href={href} className={`font-body block hover:bg-[rgba(196,163,90,0.08)] ${FOCUS}`}
      style={{ ...S.card, padding: "12px 14px", textDecoration: "none", color: palette.black, minHeight: 44, ...(alert ? { background: "#FFF8E6", borderColor: "#EBD39A" } : {}) }}>
      <span style={{ ...S.label, display: "block", color: alert ? "#7A4E00" : palette.softBlack }}>{k}</span>
      <span className="font-display" style={{ display: "block", fontSize: 30, fontWeight: 600, lineHeight: 1.1, margin: "4px 0 2px", fontVariantNumeric: "tabular-nums", color: alert ? "#7A4E00" : palette.black }}>{v}</span>
      <span style={{ display: "block", fontSize: 12, color: alert ? "#5A4210" : palette.mutedGreige, lineHeight: 1.4 }}>{d}</span>
    </Link>
  );
}

export function Tiles({ c }: { c: TileCounts }) {
  const todayD = c.today === 0 ? "Nothing booked" : [`${c.toCome} to come`, c.here ? `${c.here} here now` : null, `${c.finished} finished`].filter(Boolean).join(" · ");
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ marginBottom: 16 }}>
      <Tile href="#today" k="Today" v={c.today} d={todayD} />
      <Tile href="/admin/appointments/calendar" k="Tomorrow" v={c.tomorrow} d={c.tomorrow === 0 ? "Nothing booked" : `${c.tomorrowVideo} video · ${c.tomorrowStore} at the store`} />
      <Tile href="/admin/appointments/calendar" k="Next 7 days" v={c.week} d={`${c.weekWebsite} from the website`} />
      <Tile href="/admin/appointments/all?status=requested" k="Needs confirming" v={c.requested} d={c.requested ? "Call or WhatsApp them, then confirm" : "All confirmed"} alert={c.requested > 0} />
    </div>
  );
}
