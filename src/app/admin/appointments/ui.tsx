// Shared look for the Appointments screens: the portal's Royal Noir palette,
// uppercase letter-spaced labels, square corners, 44px tap targets.
// Server-safe (no hooks): pages and client components both import it.

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { palette } from "@/lib/palette";
import { STATUS_LABEL, type ApptStatus } from "@/lib/appointments/core";

export const TYPE_COLOR: Record<string, string> = { store: "#8A6A2E", video: "#2B4C7E", design: "#8C2331" };

export const S = {
  page: { padding: "20px 16px 96px" } as CSSProperties,
  card: { background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)", padding: 16 } as CSSProperties,
  h1: { fontSize: 24, fontWeight: 600, color: palette.black, lineHeight: 1.15 } as CSSProperties,
  h3: { fontSize: 10.5, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 600, color: palette.softBlack, margin: "0 0 10px" } as CSSProperties,
  eyebrow: { fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 600, color: palette.mutedGreige } as CSSProperties,
  label: { fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, color: palette.softBlack } as CSSProperties,
  muted: { fontSize: 12, color: palette.mutedGreige } as CSSProperties,
  body: { fontSize: 13.5, color: palette.black } as CSSProperties,
  input: { fontSize: 14, border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black, padding: "10px 12px", minHeight: 44, width: "100%" } as CSSProperties,
  row: { display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: "1px solid rgba(26,26,26,0.08)", minHeight: 44 } as CSSProperties,
};

type BtnKind = "dark" | "gold" | "outline" | "danger" | "ghost";
export function btn(kind: BtnKind = "outline", small = false): CSSProperties {
  const base: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, fontSize: small ? 10 : 11, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, minHeight: small ? 38 : 44, padding: small ? "6px 12px" : "10px 16px", whiteSpace: "nowrap", cursor: "pointer", textDecoration: "none" };
  if (kind === "dark") return { ...base, background: palette.black, color: palette.ivory, border: `1px solid ${palette.black}` };
  if (kind === "gold") return { ...base, background: palette.gold, color: palette.black, border: `1px solid ${palette.gold}` };
  if (kind === "danger") return { ...base, background: "transparent", color: palette.crimsonText, border: `1px solid ${palette.crimsonBorder}` };
  if (kind === "ghost") return { ...base, background: "transparent", color: palette.softBlack, border: "1px solid transparent" };
  return { ...base, background: "transparent", color: palette.black, border: `1px solid ${palette.black}` };
}

const STATUS_TONE: Record<ApptStatus, [string, string]> = {
  requested: ["#FBEFD2", "#7A4E00"], confirmed: ["#E2EAF5", "#274672"], arrived: ["#F1E6CC", "#6E5320"], done: ["#E1EFE4", "#245437"], no_show: ["#F6E0E0", "#8C2331"], cancelled: ["#ECE9E4", "#7A746B"],
};
export function Pill({ children, bg = "#EEE8DC", fg = "#4A4339" }: { children: ReactNode; bg?: string; fg?: string }) {
  return <span className="font-body" style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: bg, color: fg, whiteSpace: "nowrap" }}>{children}</span>;
}
export function StatusPill({ status }: { status: ApptStatus }) { const [bg, fg] = STATUS_TONE[status]; return <Pill bg={bg} fg={fg}>{STATUS_LABEL[status]}</Pill>; }
const MSG_TONE: Record<string, [string, string, string]> = {
  scheduled: ["Waiting", "#E2EAF5", "#274672"], sending: ["Sending", "#E2EAF5", "#274672"], sent: ["Sent", "#E1EFE4", "#245437"], failed: ["Failed", "#F6E0E0", "#8C2331"],
  uncertain: ["Not sure it went", "#FBEFD2", "#7A4E00"], cancelled: ["Cancelled", "#ECE9E4", "#7A746B"], skipped: ["Not sent", "#ECE9E4", "#7A746B"],
};
export function MsgStatePill({ state }: { state: string }) { const [l, bg, fg] = MSG_TONE[state] ?? [state, "#EEE8DC", "#4A4339"]; return <Pill bg={bg} fg={fg}>{l}</Pill>; }
export function TypeDot({ typeId }: { typeId: string }) { return <span aria-hidden style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: TYPE_COLOR[typeId] ?? palette.mutedGreige, flex: "none" }} />; }

export const TABS: Array<{ href: string; label: string; admin?: boolean }> = [
  { href: "/admin/appointments", label: "Overview" },
  { href: "/admin/appointments/calendar", label: "Calendar" },
  { href: "/admin/appointments/all", label: "All bookings" },
  { href: "/admin/appointments/messages", label: "Messages" },
  { href: "/admin/appointments/settings", label: "Settings", admin: true },
];
export function ApptTabs({ active, isAdmin }: { active: string; isAdmin: boolean }) {
  return (
    <nav aria-label="Appointments" className="flex overflow-x-auto" style={{ borderBottom: "1px solid rgba(26,26,26,0.12)", marginBottom: 16 }}>
      {TABS.filter((t) => !t.admin || isAdmin).map((t) => {
        const on = t.href === active;
        return <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined} className="font-body" style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 600, padding: "12px 12px", minHeight: 44, whiteSpace: "nowrap", color: on ? palette.black : palette.mutedGreige, borderBottom: `2px solid ${on ? palette.gold : "transparent"}` }}>{t.label}</Link>;
      })}
    </nav>
  );
}
export function ApptHeader({ title, eyebrow = "Appointments", right }: { title: string; eyebrow?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end gap-3 flex-wrap" style={{ marginBottom: 14 }}>
      <div style={{ minWidth: 0 }}><p className="font-body" style={S.eyebrow}>{eyebrow}</p><h1 className="font-display" style={S.h1}>{title}</h1></div>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}
export function NotSetUp({ error }: { error?: string }) {
  return (
    <div className="font-body" style={{ ...S.card, borderColor: "#EBD39A", background: "#FFF8E6", fontSize: 13.5, color: "#5A4210" }}>
      <b>Appointments are not switched on here yet.</b> The owner applies migrations 0110 and 0111 to this database first. {error ? <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.8 }}>{error}</span> : null}
    </div>
  );
}
export function TestModeNote({ automationOn, testMode }: { automationOn: boolean; testMode: boolean }) {
  const text = !automationOn ? "Automatic WhatsApp messages are off. Bookings, reminders and alerts are planned and shown here; send them by hand with the WhatsApp buttons until the owner turns automatic messages on." :
    testMode ? "Test mode: automatic WhatsApp messages go only to the test numbers in Settings." : "";
  if (!text) return null;
  return <div className="font-body" style={{ border: "1px solid #EBD39A", background: "#FFF8E6", color: "#5A4210", fontSize: 12.5, padding: "9px 12px", marginBottom: 14 }}>{text}</div>;
}
