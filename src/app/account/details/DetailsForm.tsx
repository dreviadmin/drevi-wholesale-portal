"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock3, Lock } from "lucide-react";
import { DraftNotice } from "@/components/DraftNotice";
import { PhoneInput } from "@/components/PhoneInput";
import { palette } from "@/lib/palette";
import { useDraft } from "@/lib/useDraft";
import { useToast } from "@/lib/use-toast";
import { updateMyDetails, requestIdentityChange, type IdentityField } from "@/app/account/actions";

// Two halves, and the split is the point. The top half a buyer owns outright.
// The bottom half — business name and GSTIN — prints on every GST tax invoice
// we issue them, so it is read-only here and moves only through a request a
// person decides (migration 0048).

export interface IdentityRequestDTO {
  id: string;
  field: IdentityField;
  requested_value: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

export interface DetailsFields {
  phone: string;
  address: string;
  city: string;
  transport_details: string;
  broker_details: string;
}

interface AskState {
  field: IdentityField;
  value: string;
  note: string;
}

interface DraftState {
  fields: DetailsFields;
  ask: AskState | null;
}

const EDITABLE: [keyof DetailsFields, string, string][] = [
  ["city", "City", ""],
  ["address", "Address", "Where we send the goods"],
  ["transport_details", "Transport", "Your usual transporter"],
  ["broker_details", "Broker", "If a broker handles your orders"],
];

const IDENTITY_LABEL: Record<IdentityField, string> = { business_name: "Business name", gstin: "GSTIN" };

const sig = (f: DetailsFields) => JSON.stringify(f);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const LABEL_STYLE = { fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack } as const;
const INPUT_STYLE = { borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13.5 } as const;

export function DetailsForm({
  draftKey,
  seed,
  identity,
  requests,
}: {
  draftKey: string;
  seed: DetailsFields;
  identity: Record<IdentityField, string>;
  requests: IdentityRequestDTO[];
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [toast, flash] = useToast();

  const [draft, setDraft, draftMeta] = useDraft<DraftState>(
    draftKey,
    { fields: seed, ask: null },
    {
      base: sig(seed),
      hasContent: (d) => sig(d.fields) !== sig(seed) || d.ask != null,
      // A draft written before a field existed (or before staff edited the row)
      // still restores — the server values fill the gaps.
      onRestore: (d) => ({ ...d, fields: { ...seed, ...d.fields } }),
    },
  );

  const dirty = sig(draft.fields) !== sig(seed);

  function setField(key: keyof DetailsFields, value: string) {
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));
  }

  function save() {
    start(async () => {
      const r = await updateMyDetails(draft.fields);
      if (!r.ok) {
        flash(r.error ?? "Could not save your details");
        return;
      }
      draftMeta.clear();
      flash("Details saved");
      router.refresh();
    });
  }

  function send() {
    const ask = draft.ask;
    if (!ask) return;
    start(async () => {
      const r = await requestIdentityChange(ask.field, ask.value, ask.note);
      if (!r.ok) {
        flash(r.error ?? "Could not send your request");
        return;
      }
      setDraft((d) => ({ ...d, ask: null }));
      flash("Sent to Drevi");
      router.refresh();
    });
  }

  // Newest first from the server, so the first match is the current one.
  const pendingFor = (field: IdentityField) => requests.find((r) => r.field === field && r.status === "pending") ?? null;
  const decidedFor = (field: IdentityField) =>
    requests.find((r) => r.field === field && (r.status === "approved" || r.status === "rejected")) ?? null;

  return (
    <div>
      {draftMeta.restored && (
        <div className="mb-4">
          <DraftNotice meta={draftMeta} label="Your details" />
        </div>
      )}

      <div className="flex flex-col gap-4">
        <PhoneInput value={draft.fields.phone} onChange={(v) => setField("phone", v)} />

        {EDITABLE.map(([key, label, hint]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="font-body uppercase" style={LABEL_STYLE}>{label}</span>
            {key === "address" ? (
              <textarea
                value={draft.fields[key]}
                onChange={(e) => setField(key, e.target.value)}
                rows={2}
                className="font-body bg-transparent outline-none resize-none"
                style={INPUT_STYLE}
              />
            ) : (
              <input
                value={draft.fields[key]}
                onChange={(e) => setField(key, e.target.value)}
                className="font-body bg-transparent outline-none"
                style={INPUT_STYLE}
              />
            )}
            {hint && (
              <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>{hint}</span>
            )}
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={save}
        disabled={isPending || !dirty}
        className="w-full mt-6 font-body uppercase disabled:opacity-40"
        style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "13px 0" }}
      >
        {isPending ? "Saving…" : "Save details"}
      </button>

      <div className="mt-9">
        <div className="flex items-center gap-1.5">
          <Lock size={12} strokeWidth={1.7} color={palette.mutedGreige} />
          <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>
            On your invoices
          </span>
        </div>
        <p className="font-body mt-1.5" style={{ fontSize: 11, color: palette.mutedGreige, lineHeight: 1.7 }}>
          These print on every bill we issue you, so Drevi checks a change before it takes effect. Bills already issued keep the details they were issued with.
        </p>

        {(Object.keys(IDENTITY_LABEL) as IdentityField[]).map((field) => {
          const pending = pendingFor(field);
          const decided = decidedFor(field);
          const asking = draft.ask?.field === field ? draft.ask : null;
          return (
            <div key={field} className="mt-5 pt-4" style={{ borderTop: "1px solid rgba(26,26,26,0.08)" }}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="font-body uppercase" style={LABEL_STYLE}>{IDENTITY_LABEL[field]}</div>
                  <div className="font-body mt-1" style={{ fontSize: 13.5, color: identity[field] ? palette.black : palette.mutedGreige }}>
                    {identity[field] || "Not on file"}
                  </div>
                </div>
                {!pending && !asking && (
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, ask: { field, value: identity[field] ?? "", note: "" } }))}
                    className="font-body uppercase"
                    style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep, textDecoration: "underline" }}
                  >
                    Request a change
                  </button>
                )}
              </div>

              {pending && (
                <div
                  className="flex items-start gap-2 mt-3 font-body"
                  style={{ background: palette.amberSoft, color: palette.goldDeep, padding: "9px 10px", fontSize: 11, lineHeight: 1.6 }}
                >
                  <Clock3 size={13} strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    Waiting on Drevi — you asked for <strong style={{ fontWeight: 600 }}>{pending.requested_value}</strong> on {fmtDate(pending.requested_at)}.
                  </span>
                </div>
              )}

              {decided && (
                <div
                  className="mt-3 font-body"
                  style={
                    decided.status === "approved"
                      ? { background: "#EDF5EF", color: "#1F6B45", padding: "9px 10px", fontSize: 11, lineHeight: 1.6 }
                      : { background: palette.crimsonSoft, color: palette.crimsonText, padding: "9px 10px", fontSize: 11, lineHeight: 1.6 }
                  }
                >
                  {decided.status === "approved" ? (
                    <>Updated to <strong style={{ fontWeight: 600 }}>{decided.requested_value}</strong>{decided.decided_at ? ` on ${fmtDate(decided.decided_at)}` : ""}.</>
                  ) : (
                    <>
                      Not changed to <strong style={{ fontWeight: 600 }}>{decided.requested_value}</strong>
                      {decided.decided_at ? ` on ${fmtDate(decided.decided_at)}` : ""}
                      {decided.decision_note ? ` — ${decided.decision_note}` : "."}
                    </>
                  )}
                </div>
              )}

              {asking && (
                <div className="mt-3 p-3" style={{ background: palette.ivoryDeep }}>
                  <label className="flex flex-col gap-1">
                    <span className="font-body uppercase" style={LABEL_STYLE}>New {IDENTITY_LABEL[field].toLowerCase()}</span>
                    <input
                      value={asking.value}
                      onChange={(e) => setDraft((d) => (d.ask ? { ...d, ask: { ...d.ask, value: e.target.value } } : d))}
                      autoComplete="off"
                      className="font-body bg-transparent outline-none"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label className="flex flex-col gap-1 mt-3">
                    <span className="font-body uppercase" style={LABEL_STYLE}>Why (optional)</span>
                    <input
                      value={asking.note}
                      onChange={(e) => setDraft((d) => (d.ask ? { ...d, ask: { ...d.ask, note: e.target.value } } : d))}
                      placeholder="e.g. new GST registration"
                      className="font-body bg-transparent outline-none"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <div className="flex gap-2 mt-4">
                    <button
                      type="button"
                      onClick={send}
                      disabled={isPending || !asking.value.trim()}
                      className="flex-1 font-body uppercase disabled:opacity-40"
                      style={{ background: palette.black, color: palette.ivory, fontSize: 9.5, letterSpacing: "0.16em", padding: "11px 0" }}
                    >
                      {isPending ? "Sending…" : "Send request"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, ask: null }))}
                      disabled={isPending}
                      className="font-body uppercase px-5"
                      style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 9.5, letterSpacing: "0.16em" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase text-center"
          style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "11px 20px", maxWidth: "88vw" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
