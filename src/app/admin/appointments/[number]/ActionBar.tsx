"use client";

// What can be done to the booking now, by its state: Confirm, Arrived, Done,
// No-show, Move, Cancel, Edit details, and Undo for owners and admins. The
// next likely step is the dark button.

import { useEffect, useState, type CSSProperties } from "react";
import { CalendarClock, Check, CheckCheck, DoorOpen, Pencil, RotateCcw, UserX, X } from "lucide-react";
import { ConfirmSheet } from "@/components/admin/ConfirmSheet";
import { CANCEL_REASONS, OUTCOMES, STATUS_LABEL, dayShort, firstName, hm, isLive, istParts } from "@/lib/appointments/core";
import { S, btn } from "../ui";
import { Checkbox, Chip, ErrorNote, FOCUS, inputStyle } from "../new/fields";
import { MoveSheet } from "./MoveSheet";
import { EditSheet } from "./EditSheet";
import { useBooking } from "./ctx";

type Open = null | "confirm" | "done" | "no_show" | "move" | "cancel" | "edit" | "undo";

export function ActionBar() {
  const { appt: a, now, isAdmin, automationOn, type, change, busy, errorFor, clearError } = useBooking();
  const [open, setOpen] = useState<Open>(null);
  const close = () => { setOpen(null); clearError(); };

  const start = new Date(a.starts_at).getTime(), t = now.getTime();
  const live = isLive(a.status);
  const started = start <= t + 5 * 60000;
  const canArrive = live && a.status !== "arrived" && a.place === "store" && start - 2 * 3600000 <= t;
  const canDone = live && started;
  const canNoShow = live && started && a.status !== "arrived";
  const canUndo = isAdmin && !live;
  const p = istParts(a.starts_at);
  const when = `${dayShort(p.day)} at ${hm(p.min)}`;

  // The dark button is the step most likely next.
  const primary = a.status === "requested" ? "confirm" : canArrive && !started ? "arrived" : canDone ? "done" : canArrive ? "arrived" : null;
  const style = (k: string, kind: "outline" | "danger" = "outline"): CSSProperties => btn(primary === k ? "dark" : kind);

  return (
    <div className="flex flex-col gap-2" style={{ marginBottom: 16 }}>
      <div className="flex flex-wrap gap-2">
        {a.status === "requested" ? <button type="button" className={FOCUS} style={style("confirm")} onClick={() => setOpen("confirm")}><Check size={15} aria-hidden /> Confirm</button> : null}
        {canArrive ? (
          <button type="button" className={`disabled:opacity-50 ${FOCUS}`} style={style("arrived")} disabled={busy === "arrived"} onClick={() => change("arrived", { kind: "arrived" }, `${firstName(a.customer_name)} marked as arrived`)}>
            <DoorOpen size={15} aria-hidden /> {busy === "arrived" ? "Saving…" : "Arrived"}
          </button>
        ) : null}
        {canDone ? <button type="button" className={FOCUS} style={style("done")} onClick={() => setOpen("done")}><CheckCheck size={15} aria-hidden /> Done</button> : null}
        {canNoShow ? <button type="button" className={FOCUS} style={btn("outline")} onClick={() => setOpen("no_show")}><UserX size={15} aria-hidden /> No-show</button> : null}
        {live ? <button type="button" className={FOCUS} style={btn("outline")} onClick={() => setOpen("move")}><CalendarClock size={15} aria-hidden /> Move</button> : null}
        <button type="button" className={FOCUS} style={btn("outline")} onClick={() => setOpen("edit")}><Pencil size={15} aria-hidden /> Edit details</button>
        {live ? <button type="button" className={FOCUS} style={btn("danger")} onClick={() => setOpen("cancel")}><X size={15} aria-hidden /> Cancel</button> : null}
        {canUndo ? <button type="button" className={FOCUS} style={btn("outline")} onClick={() => setOpen("undo")}><RotateCcw size={15} aria-hidden /> Undo</button> : null}
      </div>
      {live && a.place === "store" && a.status !== "arrived" && !canArrive ? <p className="font-body" style={S.muted}>Arrived opens 2 hours before the time. Done and No-show open once it has started.</p> : null}
      {live && a.place !== "store" && !started ? <p className="font-body" style={S.muted}>Done and No-show open once the call time has started.</p> : null}
      {!live && !isAdmin ? <p className="font-body" style={S.muted}>This booking is {STATUS_LABEL[a.status].toLowerCase()}. Only an owner or admin can undo it.</p> : null}
      <ErrorNote>{errorFor("arrived")}</ErrorNote>

      {open === "confirm" ? <ConfirmFlow when={when} typeName={type?.name ?? "Appointment"} automationOn={automationOn} onClose={close} /> : null}
      {open === "done" ? <DoneFlow onClose={close} /> : null}
      {open === "no_show" ? (
        <ConfirmSheet title="Mark as a no-show" confirmLabel="Mark no-show" pendingLabel="Saving…" pending={busy === "no_show"} error={errorFor("no_show")} onClose={close}
          onConfirm={async () => { if (await change("no_show", { kind: "no_show" }, "Marked as a no-show")) close(); }}>
          {a.customer_name} did not come on {when}. No more reminders go out. An owner or admin can undo this.
        </ConfirmSheet>
      ) : null}
      {open === "cancel" ? <CancelFlow when={when} onClose={close} /> : null}
      {open === "undo" ? <UndoFlow when={when} onClose={close} /> : null}
      {open === "move" ? <MoveSheet onClose={close} /> : null}
      {open === "edit" ? <EditSheet onClose={close} /> : null}
    </div>
  );
}

// The refusal the server gives when the time has filled since (it names who
// is busy and offers "book over the limit" to owners and admins).
const TIME_FULL = /busy|full|filled|over the limit|video call is on/i;

// Undo, for owners and admins. If the time has filled since the booking was
// cancelled (or marked done or a no-show), the first try is refused; the
// button then turns into "Undo over the limit", which books it anyway. The
// sheet is mounted only while open, so closing it forgets that step.
function UndoFlow({ when, onClose }: { when: string; onClose: () => void }) {
  const { appt: a, change, busy, errorFor } = useBooking();
  const [undoOver, setUndoOver] = useState(false);
  const err = errorFor("reopen");
  useEffect(() => { if (err && TIME_FULL.test(err)) setUndoOver(true); }, [err]);
  return (
    <ConfirmSheet title="Undo" tone={undoOver ? "danger" : "plain"} confirmLabel={undoOver ? "Undo over the limit" : "Back to Confirmed"} pendingLabel="Saving…" cancelLabel="Leave it"
      pending={busy === "reopen"} error={err} onClose={onClose}
      onConfirm={async () => { if (await change("reopen", undoOver ? { kind: "reopen", override: true } : { kind: "reopen" }, "Back to Confirmed")) onClose(); }}>
      <span style={{ display: "block" }}>This booking is {STATUS_LABEL[a.status].toLowerCase()}. Undo puts it back to Confirmed for {when}, and reminders are planned again if that time is still ahead.</span>
      {undoOver ? (
        <span style={{ display: "block", marginTop: 8 }}>
          <b>That time has filled up since.</b> Undo over the limit puts it back anyway, so the shop is double-booked then. Only do this if the team can cover it; otherwise leave it and make a new booking at another time.
        </span>
      ) : null}
    </ConfirmSheet>
  );
}

function ConfirmFlow({ when, typeName, automationOn, onClose }: { when: string; typeName: string; automationOn: boolean; onClose: () => void }) {
  const { appt: a, change, busy, errorFor } = useBooking();
  const [tell, setTell] = useState(a.notify_wa);
  return (
    <ConfirmSheet title="Confirm this booking" tone="plain" confirmLabel="Confirm booking" pendingLabel="Confirming…" cancelLabel="Not yet" pending={busy === "confirm"} error={errorFor("confirm")} onClose={onClose}
      onConfirm={async () => { if (await change("confirm", { kind: "confirm", tellClient: tell }, "Confirmed")) onClose(); }}>
      <span style={{ display: "block" }}>{a.customer_name}, {typeName.toLowerCase()} on {when}.</span>
      <Checkbox checked={tell} onChange={setTell}>Send the confirmation on WhatsApp</Checkbox>
      <span style={{ display: "block", ...S.muted }}>
        {!tell ? "Unticked: WhatsApp messages are turned off for this booking, so no confirmation and no reminders." : automationOn ? "It goes out straight away, then the reminders." : "Automatic messages are off right now, so after confirming, send it with Send the confirmation below."}
      </span>
    </ConfirmSheet>
  );
}

function DoneFlow({ onClose }: { onClose: () => void }) {
  const { change, busy, errorFor } = useBooking();
  const [outcome, setOutcome] = useState<string | null>(null);
  return (
    <ConfirmSheet title="Mark as done" tone="plain" confirmLabel="Mark done" pendingLabel="Saving…" cancelLabel="Not yet" pending={busy === "done"} error={errorFor("done")} onClose={onClose}
      onConfirm={async () => { if (await change("done", { kind: "done", outcome: outcome ?? undefined }, "Marked as done")) onClose(); }}>
      <span style={{ display: "block", marginBottom: 8 }}>How did it go? Optional, and it helps see what the visits turn into.</span>
      <span role="group" aria-label="Outcome" className="flex flex-wrap gap-2">
        {OUTCOMES.map((o) => <Chip key={o} on={outcome === o} onClick={() => setOutcome(outcome === o ? null : o)}>{o}</Chip>)}
      </span>
    </ConfirmSheet>
  );
}

function CancelFlow({ when, onClose }: { when: string; onClose: () => void }) {
  const { appt: a, change, busy, errorFor, automationOn } = useBooking();
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [tell, setTell] = useState(a.notify_wa);
  const full = reason === "Other" && other.trim() ? `Other: ${other.trim()}` : reason ?? undefined;
  return (
    <ConfirmSheet title="Cancel this booking" confirmLabel="Cancel booking" pendingLabel="Cancelling…" cancelLabel="Keep it" pending={busy === "cancel"} error={errorFor("cancel")} onClose={onClose}
      onConfirm={async () => { if (await change("cancel", { kind: "cancel", reason: full, tellClient: tell && a.notify_wa }, "Booking cancelled")) onClose(); }}>
      <span style={{ display: "block", marginBottom: 8 }}>{a.customer_name}, {when}. Why is it cancelled?</span>
      <span role="group" aria-label="Reason" className="flex flex-wrap gap-2">
        {CANCEL_REASONS.map((r) => <Chip key={r} on={reason === r} onClick={() => setReason(reason === r ? null : r)}>{r}</Chip>)}
      </span>
      {reason === "Other" ? (
        <input aria-label="What happened" placeholder="What happened (optional)" value={other} onChange={(e) => setOther(e.target.value)} maxLength={100} className={`font-body mt-2 ${FOCUS}`} style={inputStyle} />
      ) : null}
      <Checkbox checked={tell && a.notify_wa} disabled={!a.notify_wa} onChange={setTell}>Tell the customer on WhatsApp</Checkbox>
      <span style={{ display: "block", ...S.muted }}>
        {!a.notify_wa ? "WhatsApp messages are off for this booking, so nothing is sent. Let them know yourself." : tell && !automationOn ? "Automatic messages are off right now, so after cancelling, send the note from the Send on WhatsApp card." : "The reason stays with the team; the customer gets a short, polite note."}
      </span>
    </ConfirmSheet>
  );
}
