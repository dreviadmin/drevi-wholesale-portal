"use client";

// Move: a new day and time from the same slot list as New appointment, with
// this booking left out of the count. The customer is told on WhatsApp.

import { useState } from "react";
import { dayLabel, dayShort, firstName, hm, istParts } from "@/lib/appointments/core";
import { S } from "../ui";
import { SlotPicker, type Pick } from "../new/SlotPicker";
import { FormSheet } from "./FormSheet";
import { useBooking } from "./ctx";

export function MoveSheet({ onClose }: { onClose: () => void }) {
  const { appt, today, isAdmin, hours, closures, automationOn, change, busy, errorFor } = useBooking();
  const [pick, setPick] = useState<Pick | null>(null);
  const [reload, setReload] = useState(0);
  const cur = istParts(appt.starts_at);
  const same = !!pick && pick.day === cur.day && pick.min === cur.min;
  const override = !!pick && !pick.free && isAdmin;

  async function go() {
    if (!pick || same) return;
    const ok = await change("move", { kind: "move", day: pick.day, min: pick.min, override, tellClient: true }, `Moved to ${dayShort(pick.day)}, ${hm(pick.min)}`);
    if (ok) onClose(); else setReload((r) => r + 1);
  }

  return (
    <FormSheet
      title="Move this booking"
      confirmLabel={!pick ? "Pick a new time" : same ? "That is the current time" : override ? "Move over the limit" : `Move to ${dayShort(pick.day)}, ${hm(pick.min)}`}
      pendingLabel="Moving…"
      tone={override ? "danger" : "plain"}
      pending={busy === "move"}
      error={errorFor("move")}
      disabled={!pick || same}
      onConfirm={go}
      onClose={onClose}
    >
      <p className="font-body" style={S.body}>Now: <b>{dayLabel(cur.day, today)}, {hm(cur.min)}</b>. Pick the new day and time.</p>
      <SlotPicker
        typeId={appt.type_id} place={appt.place} party={appt.party} hostStaffId={appt.host_staff_id} exclude={appt.id}
        today={today} isAdmin={isAdmin} hours={hours} closures={closures} initialDay={cur.day} pick={pick} onPick={setPick} current={cur} reload={reload}
      />
      <p className="font-body" style={S.muted}>
        {appt.notify_wa
          ? `${firstName(appt.customer_name)} is told the new time on WhatsApp.${automationOn ? "" : " Automatic messages are off right now, so after moving, send it from the Send on WhatsApp card (Send the new time)."}`
          : "WhatsApp messages are off for this booking, so the customer is not told. Let them know yourself."}
      </p>
    </FormSheet>
  );
}
