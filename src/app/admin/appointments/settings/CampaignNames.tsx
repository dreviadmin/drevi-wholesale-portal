"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TEMPLATES } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { Pill, S, btn } from "../ui";
import { saveSettings } from "../actions";
import { FOCUS, INPUT, InlineError } from "./bits";

// One AiSensy campaign name per WhatsApp template. All 15 templates are
// approved by Meta and each has an API campaign of the same name, so this is
// folded away: it only matters if a campaign is ever set up under another name.

export function CampaignNames({ campaigns, flash }: { campaigns: Record<string, string>; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tpls = useMemo(() => Object.values(TEMPLATES), []);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(tpls.map((t) => [t.name, campaigns[t.name] ?? ""])));
  const dirty = tpls.some((t) => (draft[t.name] ?? "").trim() !== (campaigns[t.name] ?? ""));
  const overrides = tpls.filter((t) => campaigns[t.name] && campaigns[t.name] !== t.name).length;

  function save() {
    setError(null);
    start(async () => {
      const r = await saveSettings({ campaigns: Object.fromEntries(tpls.map((t) => [t.name, (draft[t.name] ?? "").trim()])) });
      if (!r.ok) { setError(r.error); return; }
      flash("Campaign names saved");
      router.refresh();
    });
  }

  return (
    <details style={{ borderTop: "1px solid rgba(26,26,26,0.12)", marginTop: 16, paddingTop: 6 }}>
      <summary className={`font-body ${FOCUS}`} style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ ...S.h3, margin: 0 }}>AiSensy campaign names</span>
        <span style={S.muted}>{overrides ? `${overrides} set to another name` : "All use the template's own name"}</span>
      </summary>
      <p className="font-body" style={{ ...S.muted, margin: "6px 0", lineHeight: 1.55, maxWidth: 680 }}>
        Each message is a WhatsApp template approved by Meta on the AiSensy project for +91 84336 59684, with an API campaign of the same name, so nothing needs typing here.
        Enter a different campaign name only if one was set up under another name.
      </p>
      <div>
        {tpls.map((t) => {
          const saved = campaigns[t.name] ?? "";
          return (
            <div key={t.name} className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center" style={{ borderTop: "1px solid rgba(26,26,26,0.08)", padding: "10px 0" }}>
              <div style={{ minWidth: 0 }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>{t.title}</span>
                  <Pill bg={t.audience === "client" ? "#E2EAF5" : "#F1E6CC"} fg={t.audience === "client" ? "#274672" : "#6E5320"}>{t.audience === "client" ? "To customers" : "To staff"}</Pill>
                  {saved && saved !== t.name && <Pill bg="#FBEFD2" fg="#7A4E00">Uses campaign {saved}</Pill>}
                </div>
                <code style={{ display: "inline-block", marginTop: 4, fontSize: 12, color: palette.softBlack, background: palette.ivoryDeep, padding: "1px 6px", wordBreak: "break-all" }}>{t.name}</code>
              </div>
              <label className="font-body block" style={{ minWidth: 0 }}>
                <span className="sr-only">AiSensy campaign name for {t.title}</span>
                <input value={draft[t.name] ?? ""} placeholder={t.name} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, [t.name]: e.target.value }))}
                  className={`font-body ${FOCUS}`} style={INPUT} />
              </label>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 12 }}>
        <button type="button" onClick={save} disabled={!dirty || pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("dark")}>{pending ? "Saving…" : "Save campaign names"}</button>
        {dirty && !pending && <span className="font-body" style={S.muted}>Not saved yet</span>}
      </div>
      <InlineError>{error}</InlineError>
    </details>
  );
}
