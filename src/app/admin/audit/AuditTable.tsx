"use client";

import { useMemo, useState } from "react";
import { palette } from "@/lib/palette";
import type { AuditEventType } from "@/lib/types";

export interface AuditRowDTO {
  event_type: AuditEventType;
  event_at: string;
  buyer: string;
  staff: string;
  notes: string | null;
  ip: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  credential_created: "Credentials created", credential_viewed: "Password viewed", credential_regenerated: "Password regenerated",
  credential_changed: "Password changed", credential_shared: "Credentials shared", login_success: "Login", login_failed: "Failed login",
  account_suspended: "Suspended", account_reactivated: "Reactivated", account_rejected: "Rejected",
};
const EVENTS = Object.keys(EVENT_LABEL) as AuditEventType[];

function fmt(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }

export function AuditTable({ rows }: { rows: AuditRowDTO[] }) {
  const [type, setType] = useState<Set<AuditEventType>>(new Set());
  const [from, setFrom] = useState("");

  const filtered = useMemo(() => rows.filter((r) => {
    if (type.size && !type.has(r.event_type)) return false;
    if (from && r.event_at < from) return false;
    return true;
  }), [rows, type, from]);

  function toggle(v: AuditEventType) {
    const n = new Set(type);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setType(n);
  }
  const chip = (active: boolean) => ({ fontSize: 9, letterSpacing: "0.1em", padding: "4px 9px", color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)" });

  return (
    <div className="px-4 md:px-8 py-6">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Audit Log</h1>
      <p className="font-body mt-1" style={{ fontSize: 11, color: palette.mutedGreige }}>Every credential and login event. Password values are never recorded.</p>

      <div className="mt-4 flex gap-1.5 flex-wrap items-center">
        {EVENTS.map((e) => <button key={e} type="button" onClick={() => toggle(e)} className="font-body uppercase" style={chip(type.has(e))}>{EVENT_LABEL[e]}</button>)}
        <label className="flex items-center gap-1.5 ml-2 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "4px 6px", fontSize: 11 }} />
        </label>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 680 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              {["Time", "Event", "Buyer", "Staff", "Notes", "IP"].map((h) => (
                <th key={h} className="font-body uppercase text-left" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "8px 10px", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <td className="font-body" style={{ fontSize: 11.5, color: palette.mutedGreige, padding: "9px 10px", whiteSpace: "nowrap" }}>{fmt(r.event_at)}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.black, padding: "9px 10px" }}>{EVENT_LABEL[r.event_type] ?? r.event_type}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "9px 10px" }}>{r.buyer}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "9px 10px" }}>{r.staff}</td>
                <td className="font-body" style={{ fontSize: 11.5, color: palette.mutedGreige, padding: "9px 10px" }}>{r.notes ?? ""}</td>
                <td className="font-body" style={{ fontSize: 11, color: palette.mutedGreige, padding: "9px 10px" }}>{r.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center py-12 font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No events match.</div>}
      </div>
    </div>
  );
}
