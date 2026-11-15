"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { TEMPLATES, sampleParams } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { Pill, S, btn } from "../ui";
import { saveSettings } from "../actions";
import { FOCUS, INPUT, InlineError, sbtn } from "./bits";

// One AiSensy campaign name per WhatsApp template. The wording and sample
// values are here so the owner can copy them into AiSensy for Meta approval.

const VAR_LABEL: Record<string, string> = {
  name: "customer's first name", customer: "customer's name and WhatsApp", what: "kind of appointment, as the customer reads it", date: "date", time: "time", number: "booking number",
  how: "how to join the call", reason: "reason", kind: "kind of appointment, for the team", when: "day and time", occasion: "occasion and its date",
  looking: "what they are looking for", source: "booked via", change: "what changed", by: "changed by",
  count: "number of appointments", list: "the day's list",
};

export function CampaignNames({ campaigns, flash }: { campaigns: Record<string, string>; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tpls = useMemo(() => Object.values(TEMPLATES), []);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(tpls.map((t) => [t.name, campaigns[t.name] ?? ""])));
  const dirty = tpls.some((t) => (draft[t.name] ?? "").trim() !== (campaigns[t.name] ?? ""));

  function save() {
    setError(null);
    start(async () => {
      const r = await saveSettings({ campaigns: Object.fromEntries(tpls.map((t) => [t.name, (draft[t.name] ?? "").trim()])) });
      if (!r.ok) { setError(r.error); return; }
      flash("Campaign names saved");
      router.refresh();
    });
  }
  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); flash(`${what} copied`); } catch { flash("Copying did not work here. Select the text and copy it instead."); }
  }

  return (
    <div style={{ borderTop: "1px solid rgba(26,26,26,0.12)", marginTop: 16, paddingTop: 14 }}>
      <h3 className="font-body" style={S.h3}>AiSensy campaign names</h3>
      <p className="font-body" style={{ ...S.muted, marginBottom: 6, lineHeight: 1.55, maxWidth: 680 }}>
        Each message is a WhatsApp template on the AiSensy project for +91 84336 59684, approved by Meta, with an API campaign of the same name.
        The portal uses that name, so nothing needs typing here. Enter a different campaign name only if one was set up under another name.
      </p>
      <div>
        {tpls.map((t) => {
          const saved = campaigns[t.name] ?? "";
          const samples = sampleParams(t);
          return (
            <div key={t.name} style={{ borderTop: "1px solid rgba(26,26,26,0.08)", padding: "12px 0" }}>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>{t.title}</span>
                    <Pill bg={t.audience === "client" ? "#E2EAF5" : "#F1E6CC"} fg={t.audience === "client" ? "#274672" : "#6E5320"}>{t.audience === "client" ? "To customers" : "To staff"}</Pill>
                    {saved && saved !== t.name && <Pill bg="#FBEFD2" fg="#7A4E00">Uses campaign {saved}</Pill>}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 4 }}>
                    <span className="font-body" style={S.muted}>Template name</span>
                    <code style={{ fontSize: 12, color: palette.softBlack, background: palette.ivoryDeep, padding: "1px 6px", wordBreak: "break-all" }}>{t.name}</code>
                    <button type="button" onClick={() => copy(t.name, "Template name")} className={`font-body ${FOCUS}`} style={{ ...sbtn("ghost"), padding: "0 8px" }} aria-label={`Copy the template name ${t.name}`}>
                      <Copy size={14} aria-hidden /> Copy
                    </button>
                  </div>
                </div>
                <label className="font-body block" style={{ minWidth: 0 }}>
                  <span className="block" style={{ ...S.label, marginBottom: 6 }}>Campaign name</span>
                  <input value={draft[t.name] ?? ""} placeholder={t.name} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, [t.name]: e.target.value }))} aria-label={`AiSensy campaign name for ${t.title}`}
                    className={`font-body ${FOCUS}`} style={INPUT} />
                </label>
              </div>
              <details style={{ marginTop: 6 }}>
                <summary className={`font-body ${FOCUS}`} style={{ fontSize: 12.5, color: palette.softBlack, minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer" }}>Wording for Meta approval</summary>
                <div style={{ background: "#fff", border: "1px solid rgba(26,26,26,0.1)", padding: 12 }}>
                  <pre className="font-body" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13, lineHeight: 1.55, color: palette.black, margin: 0 }}>{t.body}</pre>
                  <button type="button" onClick={() => copy(t.body, "Wording")} className={`font-body ${FOCUS}`} style={{ ...sbtn("outline"), marginTop: 10 }}><Copy size={14} aria-hidden /> Copy wording</button>
                  <p className="font-body" style={{ ...S.label, marginTop: 12, marginBottom: 4 }}>Sample values</p>
                  <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {t.vars.map((v, i) => (
                      <li key={v} className="font-body" style={{ fontSize: 12.5, lineHeight: 1.5, color: palette.softBlack, padding: "2px 0", wordBreak: "break-word" }}>
                        <code style={{ fontSize: 12 }}>{`{{${i + 1}}}`}</code> {VAR_LABEL[v] ?? v}: <span style={{ color: palette.black }}>{samples[i]}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 12 }}>
        <button type="button" onClick={save} disabled={!dirty || pending} className={`font-body disabled:opacity-40 ${FOCUS}`} style={btn("dark")}>{pending ? "Saving…" : "Save campaign names"}</button>
        {dirty && !pending && <span className="font-body" style={S.muted}>Not saved yet</span>}
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}
