"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { TEMPLATES, addDays, fromIst, renderParams, type Appt, type ApptType, type Tpl } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { Pill, S, btn } from "../ui";
import { saveSettings } from "../actions";
import { FOCUS, INPUT, InlineError, sbtn } from "./bits";

// One AiSensy campaign name per WhatsApp template. The wording and sample
// values are here so the owner can copy them into AiSensy for Meta approval.

const VAR_LABEL: Record<string, string> = {
  name: "customer's first name", customer: "customer's full name", type: "kind of appointment", date: "date", time: "time", number: "booking number",
  where: "where (address or how we will call)", soon: "where, short", reason: "reason", phone: "customer's WhatsApp", functions: "functions",
  fdate: "function date", looking: "what they are looking for", place: "place", source: "booked via", change: "what changed", by: "changed by",
  count: "number of appointments", list: "the day's list",
};

/** A made-up booking, only to fill Meta's sample values. */
function sampleParams(tpl: Tpl, types: ApptType[], today: string): string[] {
  const day = addDays(today, 3), now = new Date().toISOString();
  const a: Appt = {
    id: "sample", number: "A-1042", type_id: "store", place: "store", party: "solo", starts_at: fromIst(day, 16 * 60).toISOString(), ends_at: fromIst(day, 17 * 60).toISOString(),
    status: "confirmed", source: "phone", customer_name: "Ananya Mehta", phone_e164: "+919876543210", email: null, functions: ["Sangeet", "Reception or wedding day"],
    function_date: "February 2027", looking_for: "A pastel lehenga for the sangeet", staff_notes: null, meet_link: null, host_staff_id: null, notify_wa: true,
    notify_email: false, offers_ok: false, outcome: null, cancel_reason: null, manage_token: "", created_by: null, created_at: now, confirmed_at: now, cancelled_at: null, updated_at: now, rev: 1,
  };
  return renderParams(tpl.name, tpl.name === "drevi_staff_today" ? null : a, {
    types, byName: "Priya", change: "moved to 4 pm on Saturday",
    digest: { count: 3, list: "11:30 am Ananya Mehta (store visit), 2 pm Riya Shah (video shopping call), 5 pm Meera Joshi (custom design consultation)" },
  });
}

export function CampaignNames({ campaigns, types, today, flash }: { campaigns: Record<string, string>; types: ApptType[]; today: string; flash: (m: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tpls = useMemo(() => Object.values(TEMPLATES), []);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(tpls.map((t) => [t.name, campaigns[t.name] ?? ""])));
  const dirty = tpls.some((t) => (draft[t.name] ?? "").trim() !== (campaigns[t.name] ?? ""));
  const filled = tpls.filter((t) => campaigns[t.name]).length;

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
        Each message is a WhatsApp template that Meta approves before it can be sent. In AiSensy, create a Utility template with the template name and wording shown here,
        then, once it is approved, an API campaign that uses it. Enter that campaign&apos;s name below. {filled} of {tpls.length} are filled in.
      </p>
      <div>
        {tpls.map((t) => {
          const saved = campaigns[t.name] ?? "";
          const samples = sampleParams(t, types, today);
          return (
            <div key={t.name} style={{ borderTop: "1px solid rgba(26,26,26,0.08)", padding: "12px 0" }}>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-body" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>{t.title}</span>
                    <Pill bg={t.audience === "client" ? "#E2EAF5" : "#F1E6CC"} fg={t.audience === "client" ? "#274672" : "#6E5320"}>{t.audience === "client" ? "To customers" : "To staff"}</Pill>
                    {!saved && <Pill bg="#FBEFD2" fg="#7A4E00">No campaign yet</Pill>}
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
                  <input value={draft[t.name] ?? ""} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, [t.name]: e.target.value }))} aria-label={`AiSensy campaign name for ${t.title}`}
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
