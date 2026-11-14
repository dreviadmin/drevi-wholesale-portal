import Link from "next/link";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { requireStaffOrRedirect, isAdminRole } from "@/lib/staff";
import { loadConfig, listAppointments, listStaff } from "@/lib/appointments/server";
import { addDays, dayLong, fromIst, hm, hoursFor, isLive, istParts, showPhone, type Appt } from "@/lib/appointments/core";
import { ApptHeader, ApptTabs, NotSetUp, TestModeNote, btn } from "./ui";
import { FOCUS, LoadError, dayOf, isFinished, isVideo, minOf, staffMap, typeShort, hoursText, type RowCtx } from "./overview/parts";
import { Tiles } from "./overview/Tiles";
import { NeedsYou, needsYouItems } from "./overview/NeedsYou";
import { OverviewLists } from "./overview/OverviewLists";
import { BlockedTime, type BlockRow } from "./overview/BlockedTime";

export const dynamic = "force-dynamic";

// Appointments Overview: today at a glance for the shop floor. "Today" is
// always India time, whatever the server's clock zone.
export default async function AppointmentsOverviewPage() {
  const me = await requireStaffOrRedirect();
  const isAdmin = isAdminRole(me.role);
  const now = new Date();
  const today = istParts(now).day, tomorrow = addDays(today, 1);

  const shell = (body: ReactNode) => (
    <div className="px-4 md:px-8 py-6">
      <ApptHeader title="Appointments" right={<Link href="/admin/appointments/new" className={FOCUS} style={btn("dark")}><Plus size={15} aria-hidden /> New appointment</Link>} />
      <ApptTabs active="/admin/appointments" isAdmin={isAdmin} />
      {body}
    </div>
  );

  const [cfgRes, staff] = await Promise.all([loadConfig(), listStaff()]);
  if (!cfgRes.ok) return shell(cfgRes.missing ? <NotSetUp error={cfgRes.error} /> : <LoadError error={cfgRes.error} />);
  const cfg = cfgRes.data;

  // From today on, far enough to catch every booking still waiting to be confirmed.
  const horizon = Math.min(367, Math.max(60, ...cfg.types.map((t) => t.window_days)) + 1);
  const res = await listAppointments(fromIst(today, 0).toISOString(), fromIst(addDays(today, horizon), 0).toISOString());
  if (!res.ok) return shell(res.missing ? <NotSetUp error={res.error} /> : <LoadError error={res.error} />);
  const appts = res.data;

  const staffLite = staff.map((s) => ({ id: s.id, name: s.name }));
  const ctx: RowCtx = { types: cfg.types, staff: staffMap(staffLite), today };
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const inWeek = new Set(week);
  const weekShown = appts.filter((a) => inWeek.has(dayOf(a)) && a.status !== "cancelled");
  const todayList = weekShown.filter((a) => dayOf(a) === today);
  const tomorrowLive = appts.filter((a) => dayOf(a) === tomorrow && isLive(a.status));
  const weekLive = weekShown.filter((a) => isLive(a.status));

  const tiles = {
    today: todayList.length,
    toCome: todayList.filter((a) => a.status === "requested" || a.status === "confirmed").length,
    here: todayList.filter((a) => a.status === "arrived").length,
    finished: todayList.filter((a) => isFinished(a.status)).length,
    tomorrow: tomorrowLive.length,
    tomorrowVideo: tomorrowLive.filter(isVideo).length,
    tomorrowStore: tomorrowLive.filter((a) => !isVideo(a)).length,
    week: weekLive.length,
    weekWebsite: weekLive.filter((a) => a.source === "website").length,
    requested: appts.filter((a) => a.status === "requested").length,
  };

  const dayHours = Object.fromEntries(week.map((d) => [d, hoursText(hoursFor(cfg, d))]));

  // Blocked time that touches today or tomorrow (India time).
  const winStart = fromIst(today, 0).getTime(), winEnd = fromIst(addDays(today, 2), 0).getTime();
  const blocks: BlockRow[] = cfg.blocks
    .filter((b) => new Date(b.starts_at).getTime() < winEnd && new Date(b.ends_at).getTime() > winStart)
    .map((b) => {
      const s = istParts(b.starts_at), e = istParts(b.ends_at);
      return { id: b.id, day: s.day, fromMin: s.min, toMin: e.day === s.day ? e.min : 1440, takes: b.takes, note: b.note };
    });

  const copyText = todayCopyText(today, todayList, ctx);

  return shell(
    <>
      <TestModeNote automationOn={cfg.settings.automation_on} testMode={cfg.settings.test_mode} />
      <Tiles c={tiles} />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
        <OverviewLists today={today} appts={weekShown} types={cfg.types} staff={staffLite} meId={me.id} mineFirst={!isAdmin}
          dayHours={dayHours} copyText={copyText} copyCount={todayList.length} />
        <div className="flex flex-col gap-4" style={{ minWidth: 0 }}>
          <NeedsYou items={needsYouItems(appts, ctx, now)} ctx={ctx} />
          <BlockedTime today={today} blocks={blocks} hours={cfg.hours} closures={cfg.closures} />
        </div>
      </div>
    </>,
  );
}

/** Plain text for the staff WhatsApp group: one line per appointment. */
function todayCopyText(today: string, list: Appt[], ctx: RowCtx): string {
  const lines = list.map((a) => {
    const bits = [hm(minOf(a)), a.customer_name + (a.party === "group" ? " (with family)" : ""), typeShort(ctx.types, a.type_id), showPhone(a.phone_e164)];
    if (a.host_staff_id && ctx.staff[a.host_staff_id]) bits.push(`stylist ${ctx.staff[a.host_staff_id]}`);
    if (a.status === "requested") bits.push("not confirmed yet");
    if (isFinished(a.status)) bits.push(a.status === "done" ? "done" : "did not come");
    return bits.join(" · ");
  });
  return [`Drevi appointments today, ${dayLong(today)} (${list.length})`, ...lines].join("\n");
}
