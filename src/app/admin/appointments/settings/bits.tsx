"use client";

// Small pieces shared by the Settings and Messages screens: a section card, a
// switch, a phone field with a country picker, inline error and the toast.
// The look comes from ../ui (S, btn); this file only adds what those lack.

import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";
import { palette } from "@/lib/palette";
import { parsePhone, showPhone } from "@/lib/appointments/core";
import { S, btn } from "../ui";

/** Visible keyboard focus for buttons, links and inputs (inline styles cannot do :focus-visible). */
export const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/** The small button, still 44px tall so it is easy to tap on a phone. */
export function sbtn(kind: Parameters<typeof btn>[0] = "outline"): CSSProperties { return { ...btn(kind, true), minHeight: 44 }; }

/** S.input at 16px: iPhones zoom the page into any field set smaller. */
export const INPUT: CSSProperties = { ...S.input, fontSize: 16 };

export function Section({ id, title, intro, children, right }: { id: string; title: string; intro?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} style={{ ...S.card, scrollMarginTop: 16 }}>
      <div className="flex items-start gap-3 flex-wrap" style={{ marginBottom: intro ? 6 : 12 }}>
        <h2 id={`${id}-title`} className="font-display" style={{ fontSize: 18, fontWeight: 600, color: palette.black, lineHeight: 1.2, flex: 1, minWidth: 0 }}>{title}</h2>
        {right}
      </div>
      {intro && <div className="font-body" style={{ fontSize: 12.5, lineHeight: 1.55, color: palette.softBlack, marginBottom: 14, maxWidth: 680 }}>{intro}</div>}
      {children}
    </section>
  );
}

export function FieldLabel({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="font-body block" style={{ ...S.label, marginBottom: 6 }}>
      {children}
      {hint && <span className="block" style={{ ...S.muted, fontSize: 11.5, letterSpacing: 0, textTransform: "none", fontWeight: 400, marginTop: 2 }}>{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-3 font-body" style={{ minHeight: 44, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden className="relative inline-block flex-none peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gold"
        style={{ width: 40, height: 24, borderRadius: 12, background: checked ? palette.black : "rgba(26,26,26,0.2)", transition: "background 0.15s" }}>
        <span style={{ position: "absolute", top: 3, left: checked ? 19 : 3, width: 18, height: 18, borderRadius: "50%", background: checked ? palette.gold : "#fff", transition: "left 0.15s" }} />
      </span>
      <span style={{ fontSize: 13.5, color: palette.black, lineHeight: 1.35 }}>
        {label}
        {hint && <span className="block" style={{ ...S.muted, marginTop: 1 }}>{hint}</span>}
      </span>
    </label>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="font-body" style={{ fontSize: 12.5, lineHeight: 1.5, color: palette.crimsonText, marginTop: 8 }}>{children}</p>;
}

export function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12.5, maxWidth: "calc(100vw - 32px)" }}>
      <Check size={14} color={palette.gold} aria-hidden /> {text}
    </div>
  );
}

/* ---------------- phone numbers ---------------- */
export const COUNTRIES: Array<{ cc: string; label: string }> = [
  { cc: "+91", label: "India +91" },
  { cc: "+971", label: "UAE +971" },
  { cc: "+1", label: "USA or Canada +1" },
  { cc: "+44", label: "UK +44" },
  { cc: "+61", label: "Australia +61" },
  { cc: "+65", label: "Singapore +65" },
  { cc: "+64", label: "New Zealand +64" },
  { cc: "+966", label: "Saudi Arabia +966" },
  { cc: "+974", label: "Qatar +974" },
  { cc: "+965", label: "Kuwait +965" },
  { cc: "+968", label: "Oman +968" },
  { cc: "+973", label: "Bahrain +973" },
  { cc: "+977", label: "Nepal +977" },
  { cc: "+60", label: "Malaysia +60" },
  { cc: "+852", label: "Hong Kong +852" },
  { cc: "+254", label: "Kenya +254" },
  { cc: "+27", label: "South Africa +27" },
  { cc: "other", label: "Another country (type + and the code)" },
];

/** "+919876543210" -> { cc: "+91", local: "98765 43210" }; unknown codes fall back to "other" with the whole number. */
export function splitE164(e164: string | null): { cc: string; local: string } {
  if (!e164) return { cc: "+91", local: "" };
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  if (m) return { cc: "+91", local: `${m[1]} ${m[2]}` };
  const hit = COUNTRIES.filter((c) => c.cc !== "other" && e164.startsWith(c.cc)).sort((a, b) => b.cc.length - a.cc.length)[0];
  return hit ? { cc: hit.cc, local: e164.slice(hit.cc.length) } : { cc: "other", local: e164 };
}

/** The +E.164 number a phone field holds, or null while it does not look right. */
export function phoneOf(cc: string, local: string): string | null {
  const t = local.trim();
  if (!t) return null;
  if (cc === "other") return /^(\+|00)/.test(t) ? parsePhone(t) : null;
  return parsePhone(t, cc);
}

export function PhoneField({ id, label, cc, local, onChange, hint }: { id: string; label: string; cc: string; local: string; onChange: (cc: string, local: string) => void; hint?: ReactNode }) {
  const parsed = phoneOf(cc, local);
  const typed = local.trim().length > 0;
  return (
    <div>
      <FieldLabel htmlFor={id} hint={hint}>{label}</FieldLabel>
      <div className="flex gap-2">
        <select aria-label={`${label}: country`} value={cc} onChange={(e) => onChange(e.target.value, local)} className={`font-body ${FOCUS}`} style={{ ...INPUT, width: "auto", maxWidth: 150, flex: "none" }}>
          {COUNTRIES.map((c) => <option key={c.cc} value={c.cc}>{c.label}</option>)}
        </select>
        <input id={id} type="tel" inputMode="tel" autoComplete="off" value={local} onChange={(e) => onChange(cc, e.target.value)}
          className={`font-body ${FOCUS}`} style={{ ...INPUT, minWidth: 0 }} />
      </div>
      <p className="font-body" style={{ ...S.muted, marginTop: 4, color: typed && !parsed ? palette.crimsonText : palette.mutedGreige }} aria-live="polite">
        {parsed ? `Messages go to ${showPhone(parsed)}` : typed ? (cc === "+91" ? "That does not look like a 10-digit Indian mobile yet." : cc === "other" ? "Start with + and the country code." : "That number looks too short.") : cc === "other" ? "Start with + and the country code." : "The number without the country code."}
      </p>
    </div>
  );
}
