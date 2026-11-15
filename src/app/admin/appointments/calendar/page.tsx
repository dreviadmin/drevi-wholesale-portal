import Link from "next/link";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { requireStaffOrRedirect, isAdminRole } from "@/lib/staff";
import { loadConfig, listAppointments, listStaff } from "@/lib/appointments/server";
import { addDays, fromIst, hoursFor, istParts } from "@/lib/appointments/core";
import { ApptHeader, ApptTabs, NotSetUp, btn } from "../ui";
import { FOCUS, LoadError, hoursText, minOf, minutesOf, dayOf } from "../overview/parts";
import { CalendarView, type CalDay, type CalBlock } from "./CalendarView";

export const dynamic = "force-dynamic";

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

// The week at a glance, seven days from ?start (default today, India time).
export default async function AppointmentsCalendarPage({ searchParams }: { searchParams?: { start?: string | string[] } }) {
  const me = await requireStaffOrRedirect();
  const isAdmin = isAdminRole(me.role);
  const now = new Date();
  const today = istParts(now).day;
  const raw = typeof searchParams?.start === "string" ? searchParams.start.trim() : "";
  const start = isDay(raw) ? raw : today;
  const end = addDays(start, 7);

  const shell = (body: ReactNode) => (
    <div className="px-4 md:px-8 py-6">
      <ApptHeader title="Calendar" right={<Link href="/admin/appointments/new" className={FOCUS} style={btn("dark")}><Plus size={15} aria-hidden /> New appointment</Link>} />
      <ApptTabs active="/admin/appointments/calendar" isAdmin={isAdmin} />
      {body}
    </div>
  );

  const [cfgRes, res, staff] = await Promise.all([
    loadConfig(start < today ? start : undefined), // a past week still shows its closed days and blocked time
    listAppointments(fromIst(start, 0).toISOString(), fromIst(end, 0).toISOString()),
    listStaff(),
  ]);
  if (!cfgRes.ok) return shell(cfgRes.missing ? <NotSetUp error={cfgRes.error} /> : <LoadError error={cfgRes.error} />);
  if (!res.ok) return shell(res.missing ? <NotSetUp error={res.error} /> : <LoadError error={res.error} />);
  const cfg = cfgRes.data, appts = res.data;

  const days: CalDay[] = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(start, i), h = hoursFor(cfg, day);
    return "closed" in h ? { day, closed: true, hours: hoursText(h) } : { day, closed: false, open: h.open, close: h.close, hours: hoursText(h) };
  });

  // Blocked time inside the week, cut at midnight so each piece sits in one day.
  const blocks: CalBlock[] = [];
  for (const b of cfg.blocks) {
    const s = new Date(b.starts_at).getTime(), e = new Date(b.ends_at).getTime();
    for (const d of days) {
      const ds = fromIst(d.day, 0).getTime(), de = fromIst(d.day, 1440).getTime();
      if (s < de && e > ds) {
        const from = Math.max(s, ds), to = Math.min(e, de);
        blocks.push({ id: `${b.id}:${d.day}`, day: d.day, fromMin: istParts(new Date(from)).min, toMin: to === de ? 1440 : istParts(new Date(to)).min, takes: b.takes, note: b.note });
      }
    }
  }

  // Hours down the side: earliest opening to latest closing that week, widened
  // for anything booked or blocked outside them; 12 to 8 pm when all are closed.
  const edges: number[] = [];
  for (const d of days) if (!d.closed) edges.push(d.open, d.close);
  for (const a of appts) if (a.status !== "cancelled") { const m = minOf(a); edges.push(m, Math.min(1440, m + minutesOf(a))); }
  for (const b of blocks) edges.push(b.fromMin, b.toMin);
  const h0 = edges.length ? Math.floor(Math.min(...edges) / 60) * 60 : 720;
  const h1 = edges.length ? Math.ceil(Math.max(...edges) / 60) * 60 : 1200;

  return shell(
    <CalendarView
      start={start}
      today={today}
      nowIso={now.toISOString()}
      prevStart={addDays(start, -7)}
      nextStart={addDays(start, 7)}
      days={days}
      appts={appts.filter((a) => days.some((d) => d.day === dayOf(a)))}
      blocks={blocks}
      h0={Math.max(0, h1 - h0 < 60 ? h0 - 60 : h0)}
      h1={Math.min(1440, h1)}
      types={cfg.types}
      staff={staff.map((s) => ({ id: s.id, name: s.name }))}
    />,
  );
}
