import { requireStaffOrRedirect, isAdminRole } from "@/lib/staff";
import { BackLink } from "@/components/BackLink";
import { listStaff, loadConfig } from "@/lib/appointments/server";
import { addDays, istParts } from "@/lib/appointments/core";
import { ApptHeader, NotSetUp, S } from "../ui";
import { NewBookingForm } from "./NewBookingForm";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // booking changes and Send taps send WhatsApps from here

// New appointment. Optional ?day=YYYY-MM-DD and ?type=<type id> open the form
// on that day and type (for links from the calendar).
export default async function NewAppointmentPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const me = await requireStaffOrRedirect();
  const [cfg, staff] = await Promise.all([loadConfig(), listStaff()]);
  const today = istParts(new Date()).day;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const dayParam = one(searchParams?.day);
  const initialDay = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) && dayParam >= today && dayParam <= addDays(today, 60) ? dayParam : undefined;
  const typeParam = one(searchParams?.type);

  return (
    <div className="px-4 md:px-8 py-6">
      <BackLink fallback="/admin/appointments" fallbackLabel="Appointments" style={{ minHeight: 44 }} />
      <ApptHeader title="New appointment" />
      {!cfg.ok ? (
        cfg.missing ? <NotSetUp error={cfg.error} /> : (
          <div role="alert" className="font-body" style={{ ...S.card, ...S.body }}>
            <b>Could not load the appointment settings.</b> Reload the page to try again.
            <span style={{ display: "block", marginTop: 6, ...S.muted }}>{cfg.error}</span>
          </div>
        )
      ) : (
        <NewBookingForm
          types={cfg.data.types.filter((t) => t.active)}
          hours={cfg.data.hours}
          closures={cfg.data.closures}
          staff={staff.map((s) => ({ id: s.id, name: s.name }))}
          isAdmin={isAdminRole(me.role)}
          today={today}
          automationOn={cfg.data.settings.automation_on}
          testMode={cfg.data.settings.test_mode}
          initialDay={initialDay}
          initialType={typeParam || undefined}
        />
      )}
    </div>
  );
}
