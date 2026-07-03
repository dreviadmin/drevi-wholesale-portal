"use client";

import { palette } from "@/lib/palette";

/**
 * Indian mobile input: fixed +91 prefix, digits only, grouped display
 * (98765 43210). Emits the canonical "+91XXXXXXXXXX" (or "" when empty).
 * Accepts stored values in any of the historic formats.
 */
export function PhoneInput({
  value,
  onChange,
  label = "Phone",
  required = false,
}: {
  value: string;
  onChange: (canonical: string) => void;
  label?: string;
  required?: boolean;
}) {
  // strip country code + non-digits → the local 10 digits
  const local = value.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "").slice(0, 10);
  const display = local.length > 5 ? `${local.slice(0, 5)} ${local.slice(5)}` : local;

  function handle(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 10);
    onChange(digits ? `+91${digits}` : "");
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>
        {label}{required ? " *" : ""}
      </span>
      <div className="flex items-center gap-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)" }}>
        <span className="font-body" style={{ fontSize: 13, color: palette.mutedGreige, paddingBottom: 7, paddingTop: 7 }}>+91</span>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          value={display}
          onChange={(e) => handle(e.target.value)}
          placeholder="98765 43210"
          maxLength={11}
          className="font-body bg-transparent outline-none flex-1"
          style={{ padding: "7px 0", fontSize: 13, letterSpacing: "0.03em" }}
        />
        {local.length > 0 && local.length < 10 && (
          <span className="font-body" style={{ fontSize: 9, color: palette.goldDeep }}>{10 - local.length} more</span>
        )}
      </div>
    </label>
  );
}
