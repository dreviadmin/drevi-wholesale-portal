"use client";

// The confirmation the customer will get, rendered from the same template the
// sender uses, from a draft of the booking being typed.

import { palette } from "@/lib/palette";
import { handText, type Appt, type ApptType } from "@/lib/appointments/core";
import { S } from "../ui";

export function ConfirmPreview({ draft, types, status, notify, automationOn, testMode }: {
  draft: Appt; types: ApptType[]; status: "confirmed" | "requested"; notify: boolean; automationOn: boolean; testMode: boolean;
}) {
  const text = handText("c-confirm", draft, types);
  const lead = !notify
    ? "WhatsApp messages are off for this booking, so this is not sent on its own. You can still send it by hand from the booking page."
    : status === "requested"
      ? "Nothing goes to them yet. Once someone confirms the booking, they get:"
      : !automationOn
        ? "Automatic messages are off right now, so after saving, send this by hand with the WhatsApp buttons on the booking page:"
        : testMode
          ? "Test mode is on: this goes only to the test numbers in Settings, not to the customer."
          : "They get this on WhatsApp as soon as you save:";
  return (
    <div className="flex flex-col gap-2">
      <span className="font-body" style={S.label}>The confirmation message</span>
      <p className="font-body" style={{ ...S.muted, fontSize: 12.5 }}>{lead}</p>
      <div
        className="font-body"
        aria-label="Confirmation message preview"
        style={{ alignSelf: "flex-start", maxWidth: 440, width: "100%", background: "#E9F5E1", border: "1px solid #CFE3C2", padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5, color: palette.black, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {text}
      </div>
      <p className="font-body" style={S.muted}>The booking number is filled in when you save.</p>
    </div>
  );
}
