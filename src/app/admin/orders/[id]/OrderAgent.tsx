"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { useToast } from "@/lib/use-toast";
import { setOrderAgent } from "@/app/admin/agents/actions";
import type { AgentOption } from "./AgentPrompt";

/**
 * The order's agent, shown and changeable at ANY status.
 *
 * The confirmation dialog was the only way to set one, which meant a wrong
 * pick was permanent, an order confirmed before the agent existed could never
 * get one, and nothing on the page told you an agent was attached at all. The
 * dialog is still where the question gets ASKED; this is where the answer
 * lives afterwards.
 *
 * setOrderAgent does the guarding: it refuses once commission has accrued,
 * refuses an inactive agent, and accrues on the spot if the order is already
 * delivered.
 */
export function OrderAgent({
  orderId, agents, currentAgentId, currentPct, buyerAgentId, buyerName, accruedAmount, status,
}: {
  orderId: string;
  agents: AgentOption[];
  currentAgentId: string | null;
  currentPct: number | null;
  buyerAgentId: string | null;
  buyerName: string | null;
  /** Set once commission has been accrued — the association is then frozen. */
  accruedAmount: number | null;
  status: string;
}) {
  const router = useRouter();
  const [toast, flash] = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(currentAgentId);
  const [pctText, setPctText] = useState(currentPct != null ? String(currentPct) : "");
  const [alsoLink, setAlsoLink] = useState(false);

  const current = agents.find((a) => a.id === currentAgentId) ?? null;
  const chosen = agents.find((a) => a.id === agentId) ?? null;
  const frozen = accruedAmount != null;

  if (status === "cancelled") return null;

  function pick(id: string | null) {
    setAgentId(id);
    const a = agents.find((x) => x.id === id);
    setPctText(a ? String(a.defaultPct) : "");
    setAlsoLink(false);
  }

  function save() {
    start(async () => {
      const pct = pctText.trim() === "" ? null : Math.min(100, Math.max(0, Number(pctText) || 0));
      const res = await setOrderAgent(orderId, agentId, pct, alsoLink);
      if (!res.ok) { flash(res.error ?? "Could not save it"); return; }
      setOpen(false);
      flash(res.accrued != null ? `Saved · ${formatINR(res.accrued)} commission accrued` : "Saved");
      router.refresh();
    });
  }

  return (
    <div className="mt-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Agent</span>
          <div className="font-body mt-0.5" style={{ fontSize: 12.5, color: palette.black }}>
            {current ? (
              <>
                <Link href={`/admin/agents/${current.id}`} style={{ color: palette.black, fontWeight: 600 }}>{current.name}</Link>
                <span style={{ color: palette.softBlack }}> · {currentPct}%</span>
                {frozen && <span style={{ color: palette.goldDeep }}> · {formatINR(accruedAmount)} accrued</span>}
              </>
            ) : (
              <span style={{ color: palette.mutedGreige }}>None on this order</span>
            )}
          </div>
        </div>
        {!frozen && (
          <button type="button" disabled={pending} onClick={() => setOpen((v) => !v)} className="font-body uppercase disabled:opacity-40"
            style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", padding: "6px 10px" }}>
            {current ? "Change" : "Add agent"}
          </button>
        )}
      </div>

      {frozen && (
        <div className="font-body mt-1.5" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
          Commission has been accrued, so the agent and rate are frozen here. Correct it with an adjustment on the agent&apos;s page.
        </div>
      )}

      {open && !frozen && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => pick(null)} className="font-body uppercase"
              style={{ fontSize: 9.5, letterSpacing: "0.1em", padding: "6px 9px", background: agentId === null ? palette.black : "transparent", color: agentId === null ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.2)" }}>
              No agent
            </button>
            {agents.map((a) => (
              <button key={a.id} type="button" onClick={() => pick(a.id)} className="font-body uppercase"
                style={{ fontSize: 9.5, letterSpacing: "0.1em", padding: "6px 9px", background: agentId === a.id ? palette.black : "transparent", color: agentId === a.id ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.2)" }}>
                {a.name}{a.id === buyerAgentId ? " ·" : ""}
              </button>
            ))}
          </div>
          {chosen && (
            <>
              <div className="flex items-center gap-1 mt-2">
                <input type="number" min="0" max="100" step="0.01" value={pctText} onChange={(e) => setPctText(e.target.value)}
                  className="font-body text-right" style={{ fontSize: 12, width: 80, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "6px 8px" }} />
                <span className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>% on this order · {chosen.defaultPct}% is their usual</span>
              </div>
              {agentId !== buyerAgentId && (
                <label className="flex items-center gap-2 font-body mt-2" style={{ fontSize: 11.5, color: palette.softBlack }}>
                  <input type="checkbox" checked={alsoLink} onChange={(e) => setAlsoLink(e.target.checked)} style={{ accentColor: palette.goldDeep }} />
                  Also make {chosen.name} {buyerName ?? "this buyer"}&apos;s agent from now on
                </label>
              )}
            </>
          )}
          <div className="flex gap-2 mt-2.5">
            <button type="button" disabled={pending} onClick={save} className="font-body uppercase disabled:opacity-40"
              style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 14px" }}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="font-body uppercase"
              style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.softBlack, padding: "8px 10px" }}>Cancel</button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>{toast}</div>
      )}
    </div>
  );
}
