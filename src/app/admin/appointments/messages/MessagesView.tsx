"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dayShort } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import { S } from "../ui";
import { FOCUS, INPUT, Toast, sbtn } from "../settings/bits";
import { MessageList } from "./MessageList";

export interface MsgRow {
  id: string; template: string; channel: string; audience: string; recipient: string | null; to: string; due: string;
  state: string; reason: string | null; lastError: string | null; attempts: number; sentAt: string | null; number: string | null;
}
export type AudFilter = "all" | "client" | "staff";
export type StateFilter = "all" | "sent" | "waiting" | "notsent" | "trouble";

export const GROUP: Record<Exclude<StateFilter, "all">, string[]> = {
  sent: ["sent"], waiting: ["scheduled", "sending"], notsent: ["skipped", "cancelled"], trouble: ["failed", "uncertain"],
};
const TILES: Array<{ k: Exclude<StateFilter, "all">; label: string; tone: string }> = [
  { k: "sent", label: "Sent", tone: "#245437" },
  { k: "waiting", label: "Waiting", tone: "#274672" },
  { k: "notsent", label: "Not sent", tone: "#7A746B" },
  { k: "trouble", label: "Failed or not sure", tone: "#8C2331" },
];
const AUDS: Array<[AudFilter, string]> = [["all", "All"], ["client", "To customers"], ["staff", "To staff"]];

export function MessagesView({ rows, today, from, last, isDefault, isAdmin, automationOn, initialAud, initialState }: {
  rows: MsgRow[]; today: string; from: string; last: string; isDefault: boolean; isAdmin: boolean; automationOn: boolean; initialAud: AudFilter; initialState: StateFilter;
}) {
  const router = useRouter();
  const [toast, flash] = useToast();
  const [aud, setAud] = useState<AudFilter>(initialAud);
  const [state, setState] = useState<StateFilter>(initialState);

  // Filters live in the address too, so a refresh or a shared link shows the same list.
  const href = (o: { from?: string | null; aud?: AudFilter; state?: StateFilter }) => {
    const p = new URLSearchParams();
    const f = o.from === undefined ? (isDefault ? null : from) : o.from;
    if (f) p.set("from", f);
    const a = o.aud ?? aud, s = o.state ?? state;
    if (a !== "all") p.set("to", a);
    if (s !== "all") p.set("state", s);
    const q = p.toString();
    return `/admin/appointments/messages${q ? "?" + q : ""}`;
  };
  // Filtering happens here in the browser, so the address is updated without asking the server again.
  const remember = (url: string) => { try { window.history.replaceState(null, "", url); } catch { /* the list still filters */ } };
  const pickAud = (a: AudFilter) => { setAud(a); remember(href({ aud: a })); };
  const pickState = (s: StateFilter) => { setState(s); remember(href({ state: s })); };

  const byAud = useMemo(() => rows.filter((r) => aud === "all" || r.audience === aud), [rows, aud]);
  const counts = useMemo(() => Object.fromEntries(TILES.map((t) => [t.k, byAud.filter((r) => GROUP[t.k].includes(r.state)).length])) as Record<Exclude<StateFilter, "all">, number>, [byAud]);
  const shown = useMemo(() => (state === "all" ? byAud : byAud.filter((r) => GROUP[state].includes(r.state))), [byAud, state]);

  const seg = (on: boolean) => ({ ...sbtn(on ? "dark" : "outline"), border: `1px solid ${on ? palette.black : "rgba(26,26,26,0.2)"}` });

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 14 }}>
        <Link href={href({ from: addDays(from, -7) })} className={`font-body ${FOCUS}`} style={sbtn("outline")} aria-label="Show a week earlier"><ChevronLeft size={15} aria-hidden /> Earlier</Link>
        <p className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black, padding: "0 4px" }}>{dayShort(from)} to {dayShort(last)}</p>
        <Link href={href({ from: addDays(from, 7) })} className={`font-body ${FOCUS}`} style={sbtn("outline")} aria-label="Show a week later">Later <ChevronRight size={15} aria-hidden /></Link>
        {!isDefault && <Link href={href({ from: null })} className={`font-body ${FOCUS}`} style={sbtn("ghost")}>Back to this week</Link>}
        <label className="flex items-center gap-2 font-body" style={{ marginLeft: "auto" }}>
          <span style={S.label}>Starting</span>
          <input type="date" value={from} onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) router.push(href({ from: e.target.value === addDays(today, -1) ? null : e.target.value })); }}
            className={`font-body ${FOCUS}`} style={{ ...INPUT, width: "auto" }} />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2" style={{ marginBottom: 12 }}>
        {TILES.map((t) => {
          const on = state === t.k;
          return (
            <button key={t.k} type="button" aria-pressed={on} onClick={() => pickState(on ? "all" : t.k)} className={`text-left font-body ${FOCUS}`}
              style={{ background: on ? palette.ivoryDeep : palette.ivory, border: `1px solid ${on ? palette.black : "rgba(26,26,26,0.12)"}`, padding: "12px 14px", minHeight: 72, cursor: "pointer" }}>
              <span className="block" style={S.label}>{t.label}</span>
              <span className="block font-display" style={{ fontSize: 26, fontWeight: 600, color: counts[t.k] ? t.tone : palette.mutedGreige, lineHeight: 1.1, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{counts[t.k]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 12 }}>
        <div role="group" aria-label="Who the messages are to" className="flex gap-1.5 flex-wrap">
          {AUDS.map(([k, label]) => <button key={k} type="button" aria-pressed={aud === k} onClick={() => pickAud(k)} className={`font-body ${FOCUS}`} style={seg(aud === k)}>{label}</button>)}
        </div>
        <label className="flex items-center gap-2 font-body">
          <span className="sr-only">State</span>
          <select value={state} onChange={(e) => pickState(e.target.value as StateFilter)} className={`font-body ${FOCUS}`} style={{ ...INPUT, width: "auto" }}>
            <option value="all">Every state</option>
            {TILES.map((t) => <option key={t.k} value={t.k}>{t.label}</option>)}
          </select>
        </label>
      </div>

      <p className="font-body" style={{ ...S.muted, lineHeight: 1.6, marginBottom: 14, maxWidth: 760 }}>
        <b style={{ color: palette.softBlack }}>Waiting</b> will go at its time. <b style={{ color: palette.softBlack }}>Sent</b> was accepted by WhatsApp (AiSensy).{" "}
        <b style={{ color: palette.softBlack }}>Not sure it went</b>: the sender lost contact, so check with the person before sending again.{" "}
        <b style={{ color: palette.softBlack }}>Not sent</b> or <b style={{ color: palette.softBlack }}>Cancelled</b>: no consent, too late, or no longer needed. A failed message shows the reason under it.
      </p>

      {rows.length === 0 ? (
        <div className="font-body" style={{ ...S.card, fontSize: 13.5, color: palette.softBlack, lineHeight: 1.55 }}>
          No messages between {dayShort(from)} and {dayShort(last)}. Confirmations, reminders and staff alerts show here as bookings are made. Use Earlier or Later to look at other days.
        </div>
      ) : shown.length === 0 ? (
        <div className="font-body" style={{ ...S.card, fontSize: 13.5, color: palette.softBlack }}>
          Nothing matches these filters.{" "}
          <button type="button" onClick={() => { setAud("all"); setState("all"); remember(href({ aud: "all", state: "all" })); }} className={`font-body ${FOCUS}`} style={{ ...sbtn("ghost"), textDecoration: "underline" }}>Show every message</button>
        </div>
      ) : (
        <MessageList rows={shown} today={today} isAdmin={isAdmin} automationOn={automationOn} flash={flash} />
      )}
      <Toast text={toast} />
    </div>
  );
}
