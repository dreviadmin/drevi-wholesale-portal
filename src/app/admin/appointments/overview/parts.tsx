// Pieces shared by the Overview, Calendar and All bookings screens. Server-safe
// (no hooks): the server pages and the client views both import it.

import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { palette } from "@/lib/palette";
import {
  PLACE_LABEL, SOURCE_LABEL, campaignShort, dayDiff, dayShort, hm, hoursFor, istParts,
  type Appt, type ApptStatus, type ApptType,
} from "@/lib/appointments/core";
import { S, StatusPill, Pill, TypeDot } from "../ui";

/** A visible keyboard focus ring for links and buttons styled inline. */
export const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1A1A1A]";

export interface StaffLite { id: string; name: string }
/** What a row needs to turn ids into words. */
export interface RowCtx { types: ApptType[]; staff: Record<string, string>; today: string }

export const staffMap = (staff: StaffLite[]): Record<string, string> => Object.fromEntries(staff.map((s) => [s.id, s.name]));
export const dayOf = (a: Pick<Appt, "starts_at">) => istParts(a.starts_at).day;
export const minOf = (a: Pick<Appt, "starts_at">) => istParts(a.starts_at).min;
export const isFinished = (s: ApptStatus) => s === "done" || s === "no_show";
export const isVideo = (a: Pick<Appt, "place">) => a.place === "wa" || a.place === "meet";
export function typeShort(types: ApptType[], id: string): string { return types.find((t) => t.id === id)?.short_name ?? id; }
export function hostLabel(staff: Record<string, string>, id: string | null): string { return id ? staff[id] ?? "A former stylist" : "No stylist yet"; }
export function minutesOf(a: Pick<Appt, "starts_at" | "ends_at">): number { return Math.round((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000); }

/** "Open 12 pm to 8 pm", "Closed · Diwali", "Special hours 12 pm to 4 pm · Stock-taking". */
export function hoursText(h: ReturnType<typeof hoursFor>): string {
  if ("closed" in h) return h.note ? `Closed · ${h.note}` : "Closed";
  const range = `${hm(h.open)} to ${hm(h.close)}`;
  return h.special ? `Special hours ${range}${h.note ? ` · ${h.note}` : ""}` : `Open ${range}`;
}

/** Short day for a row: "Today", "Tomorrow", "Yesterday", "Sat 14 Nov", with the year when it is not this year. */
export function dayTag(day: string, today: string): string {
  const d = dayDiff(today, day);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  return day.slice(0, 4) === today.slice(0, 4) ? dayShort(day) : `${dayShort(day)} ${day.slice(0, 4)}`;
}

export function takesLabel(takes: number): string { return takes >= 99 ? "Whole shop" : takes === 1 ? "One stylist" : `${takes} stylists`; }

/** One booking as a tappable row: time, name, what and where, who hosts it, its state. */
export function ApptRow({ a, ctx, showDay = false }: { a: Appt; ctx: RowCtx; showDay?: boolean }) {
  const p = istParts(a.starts_at);
  const details = [typeShort(ctx.types, a.type_id), PLACE_LABEL[a.place], hostLabel(ctx.staff, a.host_staff_id), a.functions.length ? a.functions.join(", ") : null].filter(Boolean).join(" · ");
  const struck = a.status === "cancelled";
  return (
    <Link
      href={`/admin/appointments/${encodeURIComponent(a.number)}`}
      className={`font-body hover:bg-[rgba(196,163,90,0.08)] ${FOCUS}`}
      style={{ ...S.row, alignItems: "flex-start", padding: "11px 6px", textDecoration: "none", color: palette.black, opacity: struck ? 0.7 : 1 }}
    >
      <span style={{ width: showDay ? 84 : 64, flex: "none" }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{hm(p.min)}</span>
        <span style={{ ...S.muted, display: "block" }}>{showDay ? dayTag(p.day, ctx.today) : `${minutesOf(a)} min`}</span>
      </span>
      <span className="flex flex-col md:flex-row md:items-center gap-1.5 md:gap-3" style={{ flex: 1, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="flex items-center gap-2 flex-wrap" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
            <TypeDot typeId={a.type_id} />
            <span style={{ overflowWrap: "anywhere", textDecoration: struck ? "line-through" : undefined }}>{a.customer_name}</span>
            {a.party === "group" && <span style={{ fontWeight: 500, color: palette.mutedGreige }}>with family</span>}
          </span>
          <span style={{ display: "block", fontSize: 12.5, color: palette.softBlack, marginTop: 2, lineHeight: 1.45, overflowWrap: "anywhere" }}>{details}</span>
          {a.source === "website" && campaignShort(a.campaign) ? <span style={{ display: "block", fontSize: 12, color: "#4B3A6E", marginTop: 2, lineHeight: 1.45, overflowWrap: "anywhere" }}>From {campaignShort(a.campaign)}</span> : null}
        </span>
        <span className="flex flex-wrap gap-1.5 md:justify-end" style={{ flex: "none" }}>
          <StatusPill status={a.status} />
          {a.source !== "website" && <Pill>{SOURCE_LABEL[a.source]}</Pill>}
        </span>
      </span>
    </Link>
  );
}

/** Muted line for an empty list, with an optional action under it. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="font-body" style={{ fontSize: 13, color: palette.mutedGreige, padding: "12px 0 4px", lineHeight: 1.5 }}>
      {children}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/** A read failed for a reason other than "not set up yet". */
export function LoadError({ error }: { error: string }) {
  return (
    <div role="alert" className="font-body" style={{ ...S.card, borderColor: palette.crimsonBorder, background: palette.crimsonSoft, fontSize: 13.5, color: palette.crimsonText }}>
      <b>Could not load the appointments.</b> Reload the page to try again. If it keeps happening, send this to the owner:
      <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.85, overflowWrap: "anywhere" }}>{error}</span>
    </div>
  );
}

/** The bar a useToast() message shows in. */
export function ToastBar({ message }: { message: string | null }) {
  return (
    <div role="status" aria-live="polite">
      {message && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2"
          style={{ background: palette.black, color: palette.ivory, fontSize: 12.5, maxWidth: "calc(100vw - 32px)", width: "max-content", lineHeight: 1.45 }}>
          <Check size={13} color={palette.gold} style={{ flex: "none" }} /> <span>{message}</span>
        </div>
      )}
    </div>
  );
}

/** Small uppercase label over a filter or form control. */
export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="font-body" style={{ ...S.label, display: "block", marginBottom: 5 }}>{children}</label>;
}
