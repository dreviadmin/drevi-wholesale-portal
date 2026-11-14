"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { palette } from "@/lib/palette";
import { STATUS_LABEL, type Appt, type ApptStatus, type ApptType } from "@/lib/appointments/core";
import { S, btn } from "../ui";
import { ApptRow, Empty, FOCUS, FieldLabel, staffMap, type StaffLite } from "../overview/parts";

const BASE = "/admin/appointments/all";
const STATUSES = Object.keys(STATUS_LABEL) as ApptStatus[];
const SEARCH_CAP = 200; // searchAppointments returns at most this many

export function AllView({ q, appts, today, nowIso, types, staff, initialStatus, initialType }: {
  q: string; appts: Appt[]; today: string; nowIso: string; types: ApptType[]; staff: StaffLite[]; initialStatus: string; initialType: string;
}) {
  const router = useRouter();
  const [searching, startSearch] = useTransition();
  const [text, setText] = useState(q);
  const [fStatus, setFStatus] = useState(initialStatus === "all" || initialStatus === "open" || STATUSES.includes(initialStatus as ApptStatus) ? initialStatus : q ? "all" : "open");
  const [fType, setFType] = useState(types.some((t) => t.id === initialType) ? initialType : "all");
  const ctx = useMemo(() => ({ types, staff: staffMap(staff), today }), [types, staff, today]);

  const now = new Date(nowIso).getTime();
  const match = (a: Appt) =>
    (fType === "all" || a.type_id === fType) &&
    (fStatus === "all" || (fStatus === "open" ? a.status !== "cancelled" : a.status === fStatus));
  const shown = appts.filter(match);
  const upcoming = shown.filter((a) => new Date(a.ends_at).getTime() > now).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const past = shown.filter((a) => new Date(a.ends_at).getTime() <= now).sort((x, y) => y.starts_at.localeCompare(x.starts_at));
  const filtersOn = fType !== "all" || fStatus !== (q ? "all" : "open");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = text.trim();
    startSearch(() => router.push(t ? `${BASE}?q=${encodeURIComponent(t)}` : BASE));
  }
  const reset = () => { setFType("all"); setFStatus(q ? "all" : "open"); };

  const select = { ...S.input, fontSize: 16, appearance: "auto" as const };
  const resetBtn = <button type="button" onClick={reset} className={FOCUS} style={{ ...btn("outline", true), minHeight: 44 }}>Clear the filters</button>;
  return (
    <div style={{ minWidth: 0 }}>
      <form role="search" action={BASE} method="get" onSubmit={submit} style={{ marginBottom: 12 }}>
        <FieldLabel htmlFor="all-q">Search bookings</FieldLabel>
        <div className="flex gap-2" style={{ maxWidth: 560 }}>
          <input id="all-q" name="q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, A-number or phone" autoComplete="off"
            className={`font-body ${FOCUS}`} style={{ ...S.input, fontSize: 16, flex: 1, minWidth: 0 }} />
          <button type="submit" disabled={searching} className={`disabled:opacity-60 ${FOCUS}`} style={btn("dark")}>
            <Search size={15} aria-hidden /> {searching ? "Searching…" : "Search"}
          </button>
        </div>
        <p className="font-body" style={{ ...S.muted, margin: "6px 0 0", lineHeight: 1.5 }}>
          {q ? (
            <>
              {appts.length} booking{appts.length === 1 ? "" : "s"} found for &ldquo;{q}&rdquo;{appts.length >= SEARCH_CAP ? `. Showing the newest ${SEARCH_CAP}: add more of the name or number to narrow it` : ""}.{" "}
              <Link href={BASE} className={`underline ${FOCUS}`} style={{ color: palette.black, display: "inline-flex", alignItems: "center", minHeight: 44 }}>Clear the search</Link>
            </>
          ) : "Showing the last 30 days and the next 60. Search to find a booking from before then."}
        </p>
      </form>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ maxWidth: 560, marginBottom: 14 }}>
        <div>
          <FieldLabel htmlFor="all-type">Type</FieldLabel>
          <select id="all-type" value={fType} onChange={(e) => setFType(e.target.value)} className={`font-body ${FOCUS}`} style={select}>
            <option value="all">All types</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="all-status">Status</FieldLabel>
          <select id="all-status" value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={`font-body ${FOCUS}`} style={select}>
            <option value="open">Everything but cancelled</option>
            <option value="all">Everything, cancelled too</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>

      {q && appts.length === 0 ? (
        <div style={S.card}>
          <Empty>
            No booking matches &ldquo;{q}&rdquo;. Try part of the name, the last 4 digits of the phone number, or the booking number (like A-1001).
          </Empty>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <section aria-labelledby="all-up" style={S.card}>
            <h2 id="all-up" className="font-body" style={S.h3}>Upcoming · {upcoming.length}</h2>
            {upcoming.length ? upcoming.map((a) => <ApptRow key={a.id} a={a} ctx={ctx} showDay />) : (
              <Empty action={filtersOn ? resetBtn : undefined}>
                {filtersOn ? "No upcoming bookings match these filters." : q ? "None of these bookings is still to come." : "Nothing booked in the next 60 days. Tap New appointment to book someone in."}
              </Empty>
            )}
          </section>
          <section aria-labelledby="all-past" style={S.card}>
            <h2 id="all-past" className="font-body" style={S.h3}>Past · {past.length}</h2>
            {past.length ? past.map((a) => <ApptRow key={a.id} a={a} ctx={ctx} showDay />) : (
              <Empty action={filtersOn ? resetBtn : undefined}>
                {filtersOn ? "No past bookings match these filters." : q ? "None of these bookings is in the past." : "No bookings in the last 30 days."}
              </Empty>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
