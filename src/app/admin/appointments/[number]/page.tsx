import Link from "next/link";
import { requireStaffOrRedirect, isAdminRole } from "@/lib/staff";
import { BackLink } from "@/components/BackLink";
import { getAppointment, listStaff, loadConfig } from "@/lib/appointments/server";
import { istParts } from "@/lib/appointments/core";
import { ApptHeader, NotSetUp, S, btn } from "../ui";
import { BookingView } from "./BookingView";

export const dynamic = "force-dynamic";

// One booking: /admin/appointments/A-123 (a-123 and A123 are read as A-123).
export default async function BookingPage({ params }: { params: { number: string } }) {
  const me = await requireStaffOrRedirect();
  let raw = params.number;
  try { raw = decodeURIComponent(params.number); } catch { /* keep it as given */ }
  raw = raw.trim();
  const number = /^a-?\d+$/i.test(raw) ? "A-" + raw.replace(/\D/g, "") : raw;

  const [got, cfg, staff] = await Promise.all([getAppointment(number), loadConfig(), listStaff()]);
  const back = <BackLink fallback="/admin/appointments" fallbackLabel="Appointments" style={{ minHeight: 44 }} />;

  if (!got.ok || !cfg.ok) {
    const missing = (!got.ok && got.missing) || (!cfg.ok && cfg.missing);
    const error = !got.ok ? got.error : !cfg.ok ? cfg.error : "";
    return (
      <div className="px-4 md:px-8 py-6">
        {back}
        <ApptHeader title={number} />
        {missing ? <NotSetUp error={error} /> : (
          <div role="alert" className="font-body" style={{ ...S.card, ...S.body }}>
            <b>Could not load this booking.</b> Reload the page to try again.
            <span style={{ display: "block", marginTop: 6, ...S.muted }}>{error}</span>
          </div>
        )}
      </div>
    );
  }

  if (!got.data) {
    return (
      <div className="px-4 md:px-8 py-6">
        {back}
        <ApptHeader title="Booking not found" />
        <div className="font-body flex flex-col gap-3" style={{ ...S.card, ...S.body, maxWidth: 560 }}>
          <p>There is no booking <b>{number}</b>. Check the number, or search by the customer&apos;s name or phone in All bookings.</p>
          <div className="flex gap-2 flex-wrap">
            <Link href="/admin/appointments/all" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A88848]" style={btn("dark")}>All bookings</Link>
            <Link href="/admin/appointments/new" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A88848]" style={btn("outline")}>New appointment</Link>
          </div>
        </div>
      </div>
    );
  }

  const { appt, events, messages, others } = got.data;
  return (
    <div className="px-4 md:px-8 py-6" style={{ maxWidth: 1180 }}>
      {back}
      <BookingView
        key={appt.id}
        appt={appt}
        events={events}
        messages={messages}
        others={others}
        types={cfg.data.types}
        staff={staff.map((s) => ({ id: s.id, name: s.name }))}
        isAdmin={isAdminRole(me.role)}
        today={istParts(new Date()).day}
        nowIso={new Date().toISOString()}
        automationOn={cfg.data.settings.automation_on}
        testMode={cfg.data.settings.test_mode}
        testNumbers={cfg.data.settings.test_numbers ?? []}
        hours={cfg.data.hours}
        closures={cfg.data.closures}
      />
    </div>
  );
}
