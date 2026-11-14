"use client";

// Form parts shared by New appointment and the booking page's Move and Edit
// sheets: chips, labelled fields, the WhatsApp number with its country, and
// an inline error line. All tap targets are at least 44px tall.

import { useId, type CSSProperties, type ReactNode } from "react";
import { Check } from "lucide-react";
import { palette } from "@/lib/palette";
import { parsePhone, showPhone } from "@/lib/appointments/core";
import { S } from "../ui";

/** Visible keyboard focus for every control on these screens. */
export const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A88848]";
/** 16px text so phones do not zoom into the field. */
export const inputStyle: CSSProperties = { ...S.input, fontSize: 16 };

export function Chip({ on, onClick, children, disabled, label }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`font-body disabled:opacity-40 ${FOCUS}`}
      style={{
        minHeight: 44, padding: "8px 14px", fontSize: 13.5, lineHeight: 1.25, display: "inline-flex", alignItems: "center", gap: 8, textAlign: "left",
        border: `1px solid ${on ? palette.black : "rgba(26,26,26,0.2)"}`, background: on ? palette.black : "#fff", color: on ? palette.ivory : palette.black,
      }}
    >
      {children}
    </button>
  );
}

/** A labelled row of chips (role=group so the label is read with each chip). */
export function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2">
      <span id={id} className="font-body" style={S.label}>{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
      {hint ? <div className="font-body" style={S.muted}>{hint}</div> : null}
    </div>
  );
}

/** Label above a control. Pass the control as children; it is wrapped in the <label>. */
export function Field({ label, optional, hint, children }: { label: string; optional?: boolean; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5" style={{ minWidth: 0 }}>
      <span className="font-body" style={S.label}>
        {label}
        {optional ? <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: palette.mutedGreige }}> (optional)</span> : null}
      </span>
      {children}
      {hint ? <span className="font-body" style={S.muted}>{hint}</span> : null}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="font-body" style={{ fontSize: 13, lineHeight: 1.5, color: palette.crimsonText, background: palette.crimsonSoft, border: `1px solid ${palette.crimsonBorder}`, padding: "9px 12px" }}>
      {children}
    </div>
  );
}

export function Checkbox({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-3 font-body" style={{ minHeight: 44, padding: "10px 0", cursor: disabled ? "default" : "pointer", fontSize: 14, color: palette.black, opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className={FOCUS} style={{ width: 20, height: 20, marginTop: 1, flex: "none", accentColor: palette.black }} />
      <span style={{ lineHeight: 1.4 }}>{children}</span>
    </label>
  );
}

/* ---------------- WhatsApp number with a country ---------------- */
export const COUNTRIES: Array<{ cc: string; label: string }> = [
  { cc: "+91", label: "India +91" },
  { cc: "+971", label: "UAE +971" },
  { cc: "+44", label: "UK +44" },
  { cc: "+1", label: "US/Canada +1" },
  { cc: "+65", label: "Singapore +65" },
  { cc: "+61", label: "Australia +61" },
  { cc: "other", label: "Other" },
];
export interface PhoneVal { country: string; code: string; number: string }
export const EMPTY_PHONE: PhoneVal = { country: "+91", code: "", number: "" };

/** "+E.164" from what was typed, or null. A number typed with its own "+code" wins over the country picked. */
export function phoneE164(v: PhoneVal): string | null {
  const raw = v.number.trim();
  if (!raw) return null;
  if (/^(\+|00)/.test(raw)) return parsePhone(raw);
  if (v.country === "other") {
    const code = v.code.replace(/\D/g, "");
    return code ? parsePhone(raw, "+" + code) : null;
  }
  return parsePhone(raw, v.country);
}

/** The other way, for editing a stored number. */
export function splitPhone(e164: string): PhoneVal {
  const hit = COUNTRIES.filter((c) => c.cc !== "other" && e164.startsWith(c.cc)).sort((a, b) => b.cc.length - a.cc.length)[0];
  if (hit) {
    const rest = e164.slice(hit.cc.length);
    if (parsePhone(rest, hit.cc) === e164) return { country: hit.cc, code: "", number: hit.cc === "+91" && rest.length === 10 ? `${rest.slice(0, 5)} ${rest.slice(5)}` : rest };
  }
  return { country: "other", code: "", number: e164 };
}

export function PhoneField({ value, onChange, label = "WhatsApp number" }: { value: PhoneVal; onChange: (v: PhoneVal) => void; label?: string }) {
  const id = useId();
  const e164 = phoneE164(value);
  const digits = value.number.replace(/\D/g, "");
  const needsCode = value.country === "other" && !value.code.replace(/\D/g, "") && !/^(\+|00)/.test(value.number.trim());
  let hint: ReactNode = null;
  if (e164) hint = <span style={{ color: "#245437", display: "inline-flex", alignItems: "center", gap: 5 }}><Check size={13} aria-hidden /> WhatsApp: {showPhone(e164)}</span>;
  else if (needsCode && digits.length) hint = "Type the country code too, like +977.";
  else if (digits.length >= 6) hint = value.country === "+91" ? "Check the number: a 10-digit Indian mobile starts with 6, 7, 8 or 9. For a number abroad, pick the country first." : "Check the number. It should be the full mobile number without the country code.";
  return (
    <div className="flex flex-col gap-1.5" style={{ minWidth: 0 }}>
      <label htmlFor={id} className="font-body" style={S.label}>{label}</label>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Country"
          value={value.country}
          onChange={(e) => onChange({ ...value, country: e.target.value })}
          className={`font-body ${FOCUS}`}
          style={{ ...inputStyle, width: "auto", flex: "0 0 auto", paddingRight: 8 }}
        >
          {COUNTRIES.map((c) => <option key={c.cc} value={c.cc}>{c.label}</option>)}
        </select>
        {value.country === "other" && (
          <input
            aria-label="Country code"
            inputMode="tel"
            value={value.code}
            onChange={(e) => onChange({ ...value, code: e.target.value.replace(/[^\d+]/g, "").slice(0, 5) })}
            placeholder="+977"
            className={`font-body ${FOCUS}`}
            style={{ ...inputStyle, width: 86, flex: "0 0 auto" }}
          />
        )}
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={value.number}
          onChange={(e) => onChange({ ...value, number: e.target.value.replace(/[^\d+\s-]/g, "").slice(0, 20) })}
          placeholder={value.country === "+91" ? "98765 43210" : "Mobile number"}
          className={`font-body ${FOCUS}`}
          style={{ ...inputStyle, flex: "1 1 150px", minWidth: 0, width: "auto", letterSpacing: "0.02em" }}
        />
      </div>
      {hint ? <span className="font-body" aria-live="polite" style={S.muted}>{hint}</span> : null}
    </div>
  );
}

/** A fresh idempotency key. crypto.randomUUID needs https, which the portal has; the fallback covers a plain-http preview. */
export function newKey(): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* fall through */ }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export const SECTION: CSSProperties = { ...S.card, display: "flex", flexDirection: "column", gap: 16 };
