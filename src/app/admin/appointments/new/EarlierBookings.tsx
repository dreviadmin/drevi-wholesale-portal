"use client";

// "Booked with us before" under the WhatsApp number on New appointment.

import Link from "next/link";
import { History } from "lucide-react";
import { palette } from "@/lib/palette";
import { dayShort, istParts } from "@/lib/appointments/core";
import { S, StatusPill, btn } from "../ui";
import { FOCUS } from "./fields";
import type { EarlierCustomer } from "./actions-booking";

export function EarlierBookings({ found, typeName, applied, onUse }: { found: EarlierCustomer; typeName: (id: string) => string; applied: boolean; onUse: () => void }) {
  return (
    <div className="font-body flex flex-col gap-2" style={{ border: "1px solid #D9CBA6", background: "#FBF6EA", padding: "12px 12px 10px" }}>
      <div className="flex items-start gap-2" style={{ fontSize: 13.5, color: palette.black }}>
        <History size={16} aria-hidden style={{ flex: "none", marginTop: 2, color: palette.goldDeep }} />
        <span>
          <b>{found.name}</b> has booked with us {found.count === 1 ? "once" : `${found.count} times`} before
          {found.email ? <span style={{ color: palette.softBlack }}> · {found.email}</span> : null}
        </span>
      </div>
      <ul className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {found.bookings.map((b) => (
          <li key={b.number}>
            <Link href={`/admin/appointments/${b.number}`} target="_blank" className={`flex items-center gap-2 flex-wrap ${FOCUS}`} style={{ minHeight: 44, fontSize: 13, color: palette.black, textDecoration: "none" }}>
              <span style={{ fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3 }}>{b.number}</span>
              <span style={{ color: palette.softBlack }}>{typeName(b.type_id)}, {dayShort(istParts(b.starts_at).day)}</span>
              <StatusPill status={b.status} />
            </Link>
          </li>
        ))}
      </ul>
      {applied ? (
        <span style={S.muted}>Their name{found.email ? " and email are" : " is"} filled in below.</span>
      ) : (
        <div><button type="button" onClick={onUse} className={FOCUS} style={btn("dark")}>Use their details</button></div>
      )}
    </div>
  );
}
