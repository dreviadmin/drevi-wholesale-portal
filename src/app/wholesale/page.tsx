"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createInquiry, type InquiryState } from "./actions";
import { palette } from "@/lib/palette";

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="w-full font-body uppercase mt-2 disabled:opacity-60" style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}>
      {pending ? "Sending…" : "Request Access"}
    </button>
  );
}

export default function WholesaleInquiryPage() {
  const [state, action] = useFormState<InquiryState, FormData>(createInquiry, {});

  const field = (label: string, name: string, required = false, type = "text") => (
    <label className="flex flex-col gap-1.5">
      <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>{label}{required ? " *" : ""}</span>
      <input name={name} type={type} required={required} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 13 }} />
    </label>
  );

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12" style={{ background: palette.pageBg }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <div className="font-display" style={{ fontSize: 28, letterSpacing: "0.3em", color: palette.black, fontWeight: 600 }}>DREVI</div>
          <div className="font-body mt-2" style={{ fontSize: 10, letterSpacing: "0.22em", color: palette.mutedGreige, textTransform: "uppercase" }}>Wholesale Inquiry</div>
        </div>

        <div style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", padding: 26 }}>
          {state?.ok ? (
            <p className="font-body" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.7 }}>
              Thank you. We&apos;ve received your inquiry — Rakesh will be in touch shortly to set up your wholesale access.
            </p>
          ) : (
            <form action={action} className="flex flex-col gap-4">
              {field("Business name", "business_name", true)}
              {field("Owner name", "owner_name", true)}
              {field("Email", "email", true, "email")}
              {field("Phone", "phone", true)}
              {field("City", "city", true)}
              {field("GSTIN", "gstin")}
              <label className="flex flex-col gap-1.5">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Message</span>
                <textarea name="message" rows={2} className="font-body bg-transparent outline-none resize-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5 }} />
              </label>
              {state?.error && <p className="font-body" style={{ fontSize: 11, color: palette.crimsonText }}>{state.error}</p>}
              <SubmitBtn />
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
