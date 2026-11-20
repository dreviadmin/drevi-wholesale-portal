import { requireAdminOrRedirect } from "@/lib/staff";
import { loadConfig, listStaff } from "@/lib/appointments/server";
import { senderStatus } from "@/lib/appointments/sender";
import { istParts } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { ApptHeader, ApptTabs, NotSetUp, S } from "../ui";
import { SettingsView } from "./SettingsView";

export const dynamic = "force-dynamic";

// Appointments settings (owner and admin): types, opening hours, closed days,
// who gets the staff WhatsApps, and the WhatsApp switches and campaign names.
// Every card saves on its own through the actions in ../actions.ts.
export default async function AppointmentSettingsPage() {
  const staff = await requireAdminOrRedirect();
  const [cfg, logins, sender] = await Promise.all([loadConfig(), listStaff(), senderStatus()]);
  const today = istParts(new Date()).day;

  return (
    <div className="px-4 md:px-8 py-6">
      <ApptHeader title="Settings" />
      <ApptTabs active="/admin/appointments/settings" isAdmin />
      {cfg.ok ? (
        <SettingsView cfg={cfg.data} logins={logins} today={today} nowIso={new Date().toISOString()} sender={sender} isOwner={staff.role === "super_admin"} />
      ) : cfg.missing ? (
        <NotSetUp />
      ) : (
        <div role="alert" className="font-body" style={{ ...S.card, border: `1px solid ${palette.crimsonBorder}`, background: palette.crimsonSoft, color: palette.crimsonText, fontSize: 13.5 }}>
          <b>The settings could not be loaded.</b> Reload the page to try again.
          <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.85 }}>{cfg.error}</span>
        </div>
      )}
    </div>
  );
}
