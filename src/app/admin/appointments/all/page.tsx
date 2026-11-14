import Link from "next/link";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { requireStaffOrRedirect, isAdminRole } from "@/lib/staff";
import { loadConfig, listAppointments, listStaff, searchAppointments } from "@/lib/appointments/server";
import { addDays, fromIst, istParts } from "@/lib/appointments/core";
import { ApptHeader, ApptTabs, NotSetUp, btn } from "../ui";
import { FOCUS, LoadError } from "../overview/parts";
import { AllView } from "./AllView";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

// Every booking: searched by name, A-number or phone when ?q= is set,
// otherwise the last 30 days through the next 60 (India time).
export default async function AllBookingsPage({ searchParams }: { searchParams?: { q?: string | string[]; status?: string | string[]; type?: string | string[] } }) {
  const me = await requireStaffOrRedirect();
  const isAdmin = isAdminRole(me.role);
  const now = new Date();
  const today = istParts(now).day;
  const q = one(searchParams?.q).trim().slice(0, 80);

  const shell = (body: ReactNode) => (
    <div className="px-4 md:px-8 py-6">
      <ApptHeader title="All bookings" right={<Link href="/admin/appointments/new" className={FOCUS} style={btn("dark")}><Plus size={15} aria-hidden /> New appointment</Link>} />
      <ApptTabs active="/admin/appointments/all" isAdmin={isAdmin} />
      {body}
    </div>
  );

  const [cfgRes, res, staff] = await Promise.all([
    loadConfig(),
    q ? searchAppointments(q) : listAppointments(fromIst(addDays(today, -30), 0).toISOString(), fromIst(addDays(today, 61), 0).toISOString()),
    listStaff(),
  ]);
  if (!cfgRes.ok) return shell(cfgRes.missing ? <NotSetUp error={cfgRes.error} /> : <LoadError error={cfgRes.error} />);
  if (!res.ok) return shell(res.missing ? <NotSetUp error={res.error} /> : <LoadError error={res.error} />);

  return shell(
    <AllView
      key={q}
      q={q}
      appts={res.data}
      today={today}
      nowIso={now.toISOString()}
      types={cfgRes.data.types}
      staff={staff.map((s) => ({ id: s.id, name: s.name }))}
      initialStatus={one(searchParams?.status)}
      initialType={one(searchParams?.type)}
    />,
  );
}
