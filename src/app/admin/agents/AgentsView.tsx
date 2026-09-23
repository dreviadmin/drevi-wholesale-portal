"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Plus, Check } from "lucide-react";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { useToast } from "@/lib/use-toast";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { createAgent } from "./actions";

export interface AgentRow {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  defaultPct: number;
  active: boolean;
  orders: number;
  buyers: number;
  earned: number;
  payable: number;
  paid: number;
  balance: number;
}

const ACCESSORS: Record<string, SortAccessor<AgentRow>> = {
  name: (r) => r.name,
  city: (r) => r.city,
  pct: (r) => r.defaultPct,
  orders: (r) => r.orders,
  buyers: (r) => r.buyers,
  earned: (r) => r.earned,
  payable: (r) => r.payable,
  paid: (r) => r.paid,
  balance: (r) => r.balance,
};

export function AgentsView({ rows }: { rows: AgentRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toast, flash] = useToast();
  const [pending, start] = useTransition();

  const [form, setForm] = useState({ name: "", phone: "", city: "", defaultCommissionPct: "" });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && !r.active) return false;
      if (!q) return true;
      return [r.name, r.phone, r.city].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, query, showInactive]);

  const { sorted, sort, toggle } = useSort(filtered, ACCESSORS, { key: "balance", dir: "desc" });
  const inactiveCount = rows.filter((r) => !r.active).length;

  // The house owes the sum of what is payable and unpaid — not of what is
  // earned. Showing earned here would overstate the liability by the share of
  // every order the buyer has not paid for yet.
  const owed = useMemo(() => sorted.reduce((s, r) => s + Math.max(0, r.balance), 0), [sorted]);

  function submit() {
    start(async () => {
      const res = await createAgent({
        name: form.name,
        phone: form.phone,
        city: form.city,
        defaultCommissionPct: Number(form.defaultCommissionPct) || 0,
      });
      if (!res.ok) { flash(res.error ?? "Could not add the agent"); return; }
      setAdding(false);
      setForm({ name: "", phone: "", city: "", defaultCommissionPct: "" });
      flash(`${form.name.trim()} added`);
      router.refresh();
    });
  }

  const input = { fontSize: 12, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black, padding: "8px 10px" } as const;
  const num = { fontVariantNumeric: "tabular-nums" } as const;

  return (
    <div className="px-4 md:px-8 py-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Agents</h1>
          <div className="font-body mt-1" style={{ fontSize: 11.5, color: palette.softBlack }}>
            {sorted.length} agent{sorted.length === 1 ? "" : "s"} · <b style={{ color: palette.black }}>{formatINR(owed)}</b> payable and unpaid
          </div>
        </div>
        <button type="button" onClick={() => setAdding((v) => !v)} className="flex items-center gap-1.5 font-body uppercase"
          style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "9px 16px" }}>
          <Plus size={13} strokeWidth={2.5} /> Add Agent
        </button>
      </div>

      {adding && (
        <div className="mt-4 p-4 flex flex-col gap-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)", maxWidth: 560 }}>
          <div className="grid grid-cols-2 gap-2.5">
            <input autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name" className="font-body" style={input} />
            <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Phone" className="font-body" style={input} />
            <input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} placeholder="City" className="font-body" style={input} />
            <input type="number" min="0" max="100" step="0.01" value={form.defaultCommissionPct}
              onChange={(e) => setForm((f) => ({ ...f, defaultCommissionPct: e.target.value }))} placeholder="Commission %" className="font-body" style={input} />
          </div>
          <div className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
            The percentage is only a default — every order keeps its own copy, so changing it here never rewrites what has already been earned.
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={pending || !form.name.trim()} onClick={submit} className="font-body uppercase disabled:opacity-40"
              style={{ fontSize: 10, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "10px 18px" }}>
              {pending ? "Adding…" : "Add"}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="font-body uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "10px 12px" }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px", maxWidth: 320 }}>
          <Search size={15} strokeWidth={1.7} color={palette.mutedGreige} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone, city"
            className="font-body bg-transparent outline-none w-full" style={{ fontSize: 12, color: palette.black }} />
        </div>
        {inactiveCount > 0 && (
          <button type="button" onClick={() => setShowInactive((v) => !v)} className="font-body uppercase"
            style={{ fontSize: 9, letterSpacing: "0.12em", padding: "7px 10px", background: showInactive ? palette.black : "transparent", color: showInactive ? palette.ivory : palette.softBlack, border: "1px solid rgba(26,26,26,0.18)" }}>
            {showInactive ? "Hide" : "Show"} inactive · {inactiveCount}
          </button>
        )}
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <SortTh label="Agent" k="name" sort={sort} onToggle={toggle} />
              <SortTh label="City" k="city" sort={sort} onToggle={toggle} />
              <SortTh label="Default %" k="pct" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Buyers" k="buyers" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Orders" k="orders" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Earned" k="earned" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Payable" k="payable" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Paid" k="paid" sort={sort} onToggle={toggle} defaultDir="desc" />
              <SortTh label="Balance" k="balance" sort={sort} onToggle={toggle} defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", opacity: r.active ? 1 : 0.55 }}>
                <td style={{ padding: "10px 6px" }}>
                  <Link href={`/admin/agents/${r.id}`} className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{r.name}</Link>
                  {!r.active && <span className="font-body uppercase" style={{ marginLeft: 6, fontSize: 8, letterSpacing: "0.12em", color: palette.mutedGreige }}>inactive</span>}
                  {r.phone && <span className="font-body block" style={{ fontSize: 10.5, color: palette.mutedGreige }}>{r.phone}</span>}
                </td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px 6px" }}>{r.city ?? "—"}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px 6px", ...num }}>{r.defaultPct}%</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px 6px", ...num }}>{r.buyers}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px 6px", ...num }}>{r.orders}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px 6px", ...num }}>{formatINR(r.earned)}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px 6px", ...num }}>{formatINR(r.payable)}</td>
                <td className="font-body text-right" style={{ fontSize: 12, color: palette.softBlack, padding: "10px 6px", ...num }}>{formatINR(r.paid)}</td>
                <td className="font-display text-right" style={{ fontSize: 13, fontWeight: 600, color: r.balance < 0 ? "#9C3A31" : palette.black, padding: "10px 6px", ...num }}>{formatINR(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="text-center py-12 font-body" style={{ fontSize: 12, color: palette.mutedGreige, letterSpacing: "0.08em" }}>
            {rows.length === 0 ? "No agents yet — add the first one." : "No agents match."}
          </div>
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
