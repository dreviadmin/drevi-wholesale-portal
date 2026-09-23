"use client";

import { useState } from "react";
import { palette } from "@/lib/palette";

export interface AgentOption { id: string; name: string; defaultPct: number }

export interface AgentChoice {
  agentId: string | null;
  commissionPct: number | null;
  alsoLinkBuyer: boolean;
}

/**
 * Asked when Rakesh CONFIRMS an order (Ansh, 23 Sep: "the choice to add to the
 * buyer agent or not sits with rakesh while confirming the order").
 *
 * Confirmation is the one gate every order crosses — in-store, exhibition and
 * portal orders are all created as 'submitted' and all 25 terminal orders on
 * prod passed through confirmed_at — so this is the only place the question
 * has to be asked, and the buyer's own cart never needs an agent control.
 *
 * "No agent" is a first-class answer and the default when the buyer has none.
 * Most orders will not have one, and a dialog that insists on a choice trains
 * people to pick anything to get past it.
 */
export function AgentPrompt({
  agents, buyerAgentId, buyerName, orderNumber, onCancel, onConfirm, pending,
}: {
  agents: AgentOption[];
  buyerAgentId: string | null;
  buyerName: string | null;
  orderNumber: string;
  onCancel: () => void;
  onConfirm: (choice: AgentChoice) => void;
  pending: boolean;
}) {
  const [agentId, setAgentId] = useState<string | null>(buyerAgentId);
  const chosen = agents.find((a) => a.id === agentId) ?? null;
  const [pctText, setPctText] = useState<string>(() => {
    const seed = agents.find((a) => a.id === buyerAgentId);
    return seed ? String(seed.defaultPct) : "";
  });
  // Already theirs → nothing to link. Only offered when it would change something.
  const linkable = !!agentId && agentId !== buyerAgentId;
  const [alsoLink, setAlsoLink] = useState(false);

  function pick(id: string | null) {
    setAgentId(id);
    const a = agents.find((x) => x.id === id);
    setPctText(a ? String(a.defaultPct) : "");
    setAlsoLink(false);
  }

  const pct = pctText.trim() === "" ? null : Math.min(100, Math.max(0, Number(pctText) || 0));
  const ready = !pending && (!agentId || (pct != null && pct >= 0));

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={() => !pending && onCancel()}>
      <div className="w-full sm:max-w-md max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
        <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>Confirm {orderNumber}</div>
        <p className="font-body mt-2" style={{ fontSize: 11.5, lineHeight: 1.6, color: palette.softBlack }}>
          Is an agent owed commission on this order? Their share is earned when it is delivered, and
          becomes payable as {buyerName ?? "the buyer"} pays.
        </p>

        <div className="flex flex-wrap gap-1.5 mt-3">
          <button type="button" onClick={() => pick(null)} className="font-body uppercase"
            style={{ fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 10px", background: agentId === null ? palette.black : "transparent", color: agentId === null ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.2)" }}>
            No agent
          </button>
          {agents.map((a) => (
            <button key={a.id} type="button" onClick={() => pick(a.id)} className="font-body uppercase"
              style={{ fontSize: 9.5, letterSpacing: "0.1em", padding: "7px 10px", background: agentId === a.id ? palette.black : "transparent", color: agentId === a.id ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.2)" }}>
              {a.name}{a.id === buyerAgentId ? " ·" : ""}
            </button>
          ))}
        </div>
        {buyerAgentId && (
          <div className="font-body mt-1.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
            · already {buyerName ?? "this buyer"}&apos;s agent
          </div>
        )}

        {chosen && (
          <>
            <div className="flex items-center justify-between mt-3">
              <span className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>Commission on this order</span>
              <span className="flex items-center gap-1">
                <input type="number" min="0" max="100" step="0.01" value={pctText} onChange={(e) => setPctText(e.target.value)}
                  className="font-body text-right" style={{ fontSize: 12, width: 80, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "7px 9px" }} />
                <span className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>%</span>
              </span>
            </div>
            <div className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
              {chosen.defaultPct}% is their usual rate. This order keeps its own copy either way.
            </div>

            {linkable && (
              <label className="flex items-center gap-2 font-body mt-3" style={{ fontSize: 11.5, color: palette.softBlack }}>
                <input type="checkbox" checked={alsoLink} onChange={(e) => setAlsoLink(e.target.checked)} style={{ accentColor: palette.goldDeep }} />
                Also make {chosen.name} {buyerName ?? "this buyer"}&apos;s agent from now on
              </label>
            )}
          </>
        )}

        <div className="flex gap-2 mt-4">
          <button type="button" disabled={!ready} onClick={() => onConfirm({ agentId, commissionPct: pct, alsoLinkBuyer: alsoLink })}
            className="flex-1 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.black, color: palette.ivory, padding: "12px 0" }}>
            {pending ? "Confirming…" : "Confirm order"}
          </button>
          <button type="button" disabled={pending} onClick={onCancel} className="font-body uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "12px 14px" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
