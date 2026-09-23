"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, AlertTriangle } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { useToast } from "@/lib/use-toast";
import { BackLink } from "@/components/BackLink";
import { payoutCheck, type AgentTotals } from "@/lib/agent-core";
import type { AgentOrderRow } from "@/lib/agent-ledger";
import { recordAgentPayment, voidAgentPayment, updateAgent } from "../actions";

interface PaymentRow {
  id: string; amount: number; method: string | null; reference: string | null;
  paidOn: string; note: string | null; voidedAt: string | null; voidReason: string | null; createdBy: string | null;
}

const METHODS = ["Cash", "Bank transfer", "UPI", "Cheque"];
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—";

export function AgentDetail({
  agent, totals, orders, payments, buyers,
}: {
  agent: { id: string; name: string; phone: string | null; email: string | null; city: string | null; address: string | null; notes: string | null; defaultPct: number; active: boolean };
  totals: AgentTotals;
  orders: AgentOrderRow[];
  payments: PaymentRow[];
  buyers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [toast, flash] = useToast();
  const [pending, start] = useTransition();
  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());

  const check = payoutCheck(totals.balance, Number(amount) || 0);
  const num = { fontVariantNumeric: "tabular-nums" } as const;

  function pay() {
    start(async () => {
      const res = await recordAgentPayment({
        agentId: agent.id, amount: Number(amount) || 0,
        method, reference, note, clientRef,
      });
      if (!res.ok) { flash(res.error ?? "Could not record it"); return; }
      setPayOpen(false); setAmount(""); setMethod(""); setReference(""); setNote("");
      setClientRef(crypto.randomUUID());
      flash("Payment recorded");
      router.refresh();
    });
  }

  const tile = (label: string, value: number, hint?: string, tone?: "muted" | "warn") => (
    <div style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)", padding: "12px 14px" }}>
      <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>{label}</div>
      <div className="font-display mt-1" style={{ fontSize: 19, fontWeight: 600, color: tone === "warn" && value < 0 ? "#9C3A31" : tone === "muted" ? palette.softBlack : palette.black, ...num }}>
        {formatINR(value)}
      </div>
      {hint && <div className="font-body mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );

  return (
    <div className="px-4 md:px-8 py-6">
      <BackLink fallback="/admin/agents" fallbackLabel="Agents" />

      <div className="mt-3 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>
            {agent.name}
            {!agent.active && <span className="font-body uppercase" style={{ marginLeft: 8, fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>inactive</span>}
          </h1>
          <div className="font-body mt-1" style={{ fontSize: 12, color: palette.softBlack }}>
            {[agent.phone, agent.email, agent.city].filter(Boolean).join(" · ") || "—"} · default {agent.defaultPct}%
          </div>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => {
            const res = await updateAgent(agent.id, { active: !agent.active });
            flash(res.ok ? (agent.active ? "Marked inactive" : "Reactivated") : res.error ?? "Failed");
            if (res.ok) router.refresh();
          })}
          className="font-body uppercase disabled:opacity-40"
          style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", padding: "7px 12px" }}
        >
          {agent.active ? "Mark inactive" : "Reactivate"}
        </button>
      </div>

      {/* Four figures, not one. Earned and payable differ by whatever the
          buyers have not paid yet, and on this book that gap is most of it. */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
        {tile("Earned", totals.earned, "commission on delivered orders", "muted")}
        {tile("Payable", totals.payable, "the share buyers have paid for")}
        {tile("Paid", totals.paid, `${payments.filter((p) => !p.voidedAt).length} payout(s)`, "muted")}
        {tile("Balance", totals.balance, totals.balance < 0 ? "paid ahead — nets against the next order" : "payable, not yet paid", "warn")}
      </div>

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => setPayOpen((v) => !v)} className="font-body uppercase"
          style={{ fontSize: 10, letterSpacing: "0.16em", background: palette.gold, color: palette.black, padding: "10px 16px" }}>
          Record a payment
        </button>
        {buyers.length > 0 && (
          <span className="font-body" style={{ fontSize: 11, color: palette.softBlack }}>
            {buyers.length} buyer{buyers.length === 1 ? "" : "s"} linked:{" "}
            {buyers.slice(0, 4).map((b, i) => (
              <span key={b.id}>
                {i > 0 && ", "}
                <Link href={`/admin/buyers/${b.id}`} style={{ color: palette.goldDeep, textDecoration: "underline" }}>{b.name}</Link>
              </span>
            ))}
            {buyers.length > 4 && ` +${buyers.length - 4}`}
          </span>
        )}
      </div>

      {payOpen && (
        <div className="mt-3 p-4 flex flex-col gap-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)", maxWidth: 520 }}>
          <div className="font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
            <b style={{ color: palette.black }}>{formatINR(totals.balance)}</b> payable right now.
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input autoFocus type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount"
              className="font-body" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }} />
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no. (optional)"
              className="font-body" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" }} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {METHODS.map((m) => (
              <button key={m} type="button" onClick={() => setMethod(m)} className="font-body uppercase"
                style={{ fontSize: 9, letterSpacing: "0.1em", padding: "6px 9px", background: method === m ? palette.black : "transparent", color: method === m ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.2)" }}>
                {m}
              </button>
            ))}
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)"
            className="font-body" style={{ fontSize: 11.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "7px 9px" }} />
          {amount && !check.ok && <div className="font-body" style={{ fontSize: 10.5, color: "#9C3A31" }}>{check.error}</div>}
          <div className="flex gap-2">
            <button type="button" disabled={pending || !check.ok} onClick={pay} className="font-body uppercase disabled:opacity-40"
              style={{ fontSize: 10, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "10px 18px" }}>
              {pending ? "Recording…" : "Record"}
            </button>
            <button type="button" onClick={() => setPayOpen(false)} className="font-body uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "10px 12px" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Order-wise breakdown */}
      <h2 className="font-body uppercase mt-8" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Orders</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              {["Order", "Buyer", "Base", "%", "Commission", "Collected", "Payable", "Accrued"].map((h, i) => (
                <th key={h} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.mutedGreige, textAlign: i >= 2 && i <= 6 ? "right" : "left", padding: "7px 6px" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.orderId} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <td style={{ padding: "9px 6px" }}>
                  <Link href={`/admin/orders/${o.orderId}`} className="font-mono" style={{ fontSize: 11.5, fontWeight: 600, color: palette.black }}>{o.orderNumber}</Link>
                  {o.revisedSinceAccrual && (
                    <span className="font-body inline-flex items-center gap-1" style={{ marginLeft: 6, fontSize: 9, color: "#8a6d1a" }}
                      title="The order's lines changed after this commission was frozen — the figure below is the one that was accrued.">
                      <AlertTriangle size={10} /> revised
                    </span>
                  )}
                  {o.adjustments.map((a, i) => (
                    <span key={i} className="font-body block" style={{ fontSize: 9.5, color: "#9C3A31" }}>
                      {a.reason === "return" ? "return" : a.reason}: {formatINR(a.delta)}{a.note ? ` · ${a.note}` : ""}
                    </span>
                  ))}
                </td>
                <td className="font-body" style={{ fontSize: 11.5, color: palette.softBlack, padding: "9px 6px" }}>{o.buyerName ?? "—"}</td>
                <td className="font-body text-right" style={{ fontSize: 11.5, color: palette.softBlack, padding: "9px 6px", ...num }}>{formatINR(o.base)}</td>
                <td className="font-body text-right" style={{ fontSize: 11.5, color: palette.softBlack, padding: "9px 6px", ...num }}>{o.pct}%</td>
                <td className="font-body text-right" style={{ fontSize: 11.5, color: palette.black, padding: "9px 6px", ...num }}>{formatINR(o.amount)}</td>
                <td className="font-body text-right" style={{ fontSize: 11.5, color: o.collected < 1 ? "#8a6d1a" : palette.softBlack, padding: "9px 6px", ...num }}>{Math.round(o.collected * 100)}%</td>
                <td className="font-display text-right" style={{ fontSize: 12, fontWeight: 600, color: palette.black, padding: "9px 6px", ...num }}>{formatINR(o.payable)}</td>
                <td className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige, padding: "9px 6px" }}>{fmtDate(o.accruedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && (
          <div className="text-center py-8 font-body" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
            No commission yet — it is earned when one of their orders is delivered.
          </div>
        )}
      </div>

      {/* Payment history */}
      <h2 className="font-body uppercase mt-8" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Payments</h2>
      <div className="mt-2 flex flex-col gap-1.5">
        {payments.map((p) => (
          <div key={p.id} className="flex items-baseline justify-between gap-3 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", opacity: p.voidedAt ? 0.5 : 1 }}>
            <div>
              <span className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black, textDecoration: p.voidedAt ? "line-through" : undefined, ...num }}>{formatINR(p.amount)}</span>
              <span className="font-body" style={{ marginLeft: 8, fontSize: 11, color: palette.softBlack }}>
                {fmtDate(p.paidOn)}{p.method ? ` · ${p.method}` : ""}{p.reference ? ` · ${p.reference}` : ""}
              </span>
              {p.note && <span className="font-body block" style={{ fontSize: 10.5, color: palette.mutedGreige }}>{p.note}</span>}
              {p.voidedAt && <span className="font-body block" style={{ fontSize: 10, color: "#9C3A31" }}>voided — {p.voidReason}</span>}
            </div>
            {!p.voidedAt && (
              <button type="button" disabled={pending}
                onClick={() => {
                  const reason = window.prompt("Void this payment? It is kept and struck through, never deleted.\n\nReason:");
                  if (!reason?.trim()) return;
                  start(async () => {
                    const res = await voidAgentPayment(p.id, reason);
                    flash(res.ok ? "Voided" : res.error ?? "Failed");
                    if (res.ok) router.refresh();
                  });
                }}
                className="font-body uppercase disabled:opacity-40"
                style={{ fontSize: 8.5, letterSpacing: "0.1em", border: "1px solid #9C3A31", color: "#9C3A31", background: "transparent", padding: "5px 8px" }}>
                Void
              </button>
            )}
          </div>
        ))}
        {payments.length === 0 && (
          <div className="text-center py-8 font-body" style={{ fontSize: 11.5, color: palette.mutedGreige }}>No payments yet.</div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          <Check size={13} color={palette.gold} /> {toast}
        </div>
      )}
    </div>
  );
}
