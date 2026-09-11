"use client";

import { palette } from "@/lib/palette";
import type { DraftMeta } from "@/lib/useDraft";

function relTime(savedAt: number | null): string | null {
  if (savedAt == null) return null;
  const s = Math.max(0, Math.round((Date.now() - savedAt) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Renders only while a draft has been restored and not yet dismissed/cleared.
// Stale = the server row changed since the draft was written; the user's edit
// is kept by default and the notice is the safeguard.
export function DraftNotice({ meta, label }: { meta: DraftMeta; label?: string }) {
  if (!meta.restored) return null;
  const btnStyle = { fontSize: 9.5, letterSpacing: "0.14em", color: palette.goldDeep, background: "transparent", padding: 0, textDecoration: "underline" };
  const age = relTime(meta.savedAt);
  return (
    <div
      role="status"
      className="font-body uppercase flex flex-wrap items-center gap-x-2 gap-y-1"
      style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.amberSoft, color: palette.goldDeep, padding: "8px 10px" }}
    >
      {meta.stale ? (
        <>
          <span>{label ? `${label} — unsaved draft restored, this record changed on the server since` : "Unsaved draft restored — this record changed on the server since"}</span>
          <span>·</span>
          <button type="button" onClick={meta.dismiss} className="font-body uppercase" style={btnStyle}>Keep mine</button>
          <span>/</span>
          <button type="button" onClick={meta.discard} className="font-body uppercase" style={btnStyle}>Use server</button>
        </>
      ) : (
        <>
          <span>{label ?? "Draft restored"}</span>
          {age && (<><span>·</span><span>{age}</span></>)}
          <span>·</span>
          <button type="button" onClick={meta.discard} className="font-body uppercase" style={btnStyle}>Discard</button>
        </>
      )}
    </div>
  );
}
