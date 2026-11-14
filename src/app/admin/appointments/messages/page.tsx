import { requireStaffOrRedirect, isAdminRole } from "@/lib/staff";
import { listMessages, loadConfig } from "@/lib/appointments/server";
import { addDays, fromIst, istParts } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { ApptHeader, ApptTabs, NotSetUp, S, TestModeNote } from "../ui";
import { MessagesView, type MsgRow, type AudFilter, type StateFilter } from "./MessagesView";

export const dynamic = "force-dynamic";

// Messages: every appointment WhatsApp the portal has planned, sent or given up
// on, for a window of days in India time (default yesterday to a week ahead).
const SPAN = 9; // yesterday, today and the next 7 days
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
const AUD: AudFilter[] = ["all", "client", "staff"];
const STATES: StateFilter[] = ["all", "sent", "waiting", "notsent", "trouble"];

export default async function AppointmentMessagesPage({ searchParams }: { searchParams?: { from?: string; to?: string; state?: string } }) {
  const staff = await requireStaffOrRedirect();
  const isAdmin = isAdminRole(staff.role);
  const today = istParts(new Date()).day;
  const defFrom = addDays(today, -1);
  const from = isDay(searchParams?.from) ? searchParams!.from! : defFrom;
  const until = addDays(from, SPAN); // first day after the window
  const aud = AUD.includes(searchParams?.to as AudFilter) ? (searchParams!.to as AudFilter) : "all";
  const state = STATES.includes(searchParams?.state as StateFilter) ? (searchParams!.state as StateFilter) : "all";

  const [cfg, msgs] = await Promise.all([loadConfig(), listMessages(fromIst(from, 0).toISOString(), fromIst(until, 0).toISOString())]);
  const missing = (!cfg.ok && cfg.missing) || (!msgs.ok && msgs.missing);
  const failed = !cfg.ok ? cfg.error : !msgs.ok ? msgs.error : null;

  const rows: MsgRow[] = msgs.ok
    ? msgs.data.map((m) => ({
        id: m.id, template: m.template, channel: m.channel, audience: m.audience, recipient: m.recipient_name, to: m.to_address, due: m.due_at,
        state: m.state, reason: m.reason, lastError: m.last_error, attempts: m.attempts, sentAt: m.sent_at, number: m.number ?? null,
      }))
    : [];

  return (
    <div className="px-4 md:px-8 py-6">
      <ApptHeader title="Messages" />
      <ApptTabs active="/admin/appointments/messages" isAdmin={isAdmin} />
      {missing ? (
        <NotSetUp />
      ) : failed ? (
        <div role="alert" className="font-body" style={{ ...S.card, border: `1px solid ${palette.crimsonBorder}`, background: palette.crimsonSoft, color: palette.crimsonText, fontSize: 13.5 }}>
          <b>The messages could not be loaded.</b> Reload the page to try again.
          <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.85 }}>{failed}</span>
        </div>
      ) : (
        <>
          {cfg.ok && <TestModeNote automationOn={cfg.data.settings.automation_on} testMode={cfg.data.settings.test_mode} />}
          <MessagesView rows={rows} today={today} from={from} last={addDays(until, -1)} isDefault={from === defFrom} isAdmin={isAdmin}
            automationOn={cfg.ok ? cfg.data.settings.automation_on : false} initialAud={aud} initialState={state} />
        </>
      )}
    </div>
  );
}
