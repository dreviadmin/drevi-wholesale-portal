"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { upsertLov, setLovActive, type LovList } from "./actions";
import { palette } from "@/lib/palette";

export interface LovRow {
  id: string;
  list: LovList;
  code: string;
  label: string;
  sort: number;
  active: boolean;
}

const LIST_LABEL: Record<LovList, string> = {
  category: "Categories",
  sub_category: "Sub-categories",
  color: "Colours",
  size: "Sizes",
  fabric: "Fabrics",
  occasion: "Occasions",
};

export function LovsEditor({ rows }: { rows: LovRow[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<LovList>("category");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2400); };
  const visible = useMemo(() => rows.filter((r) => r.list === tab), [rows, tab]);

  function add() {
    if (!code.trim()) return;
    start(async () => {
      const res = await upsertLov({ list: tab, code, label });
      if (!res.ok) { flash(res.error ?? "Failed"); return; }
      setCode("");
      setLabel("");
      flash("Added");
      router.refresh();
    });
  }

  function toggle(row: LovRow) {
    start(async () => {
      const res = await setLovActive(row.id, !row.active);
      flash(res.ok ? (row.active ? "Deactivated" : "Reactivated") : res.error ?? "Failed");
      router.refresh();
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Lists of values</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, lineHeight: 1.6, color: palette.softBlack }}>
        The lists minting, goods-in and the master editor offer. Codes deactivate rather than delete —
        existing SKUs may reference them.
      </p>

      <div className="flex gap-1.5 mt-4 flex-wrap">
        {(Object.keys(LIST_LABEL) as LovList[]).map((l) => (
          <button key={l} type="button" onClick={() => setTab(l)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", padding: "6px 11px", background: tab === l ? palette.black : "transparent", color: tab === l ? palette.ivory : palette.softBlack, border: tab === l ? "none" : "1px solid rgba(26,26,26,0.18)" }}>
            {LIST_LABEL[l]}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-2 mt-4 flex-wrap">
        <label className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="block font-mono mt-1" style={{ width: 110, border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12, background: "#fff", color: palette.black }} />
        </label>
        <label className="font-body flex-1" style={{ fontSize: 9.5, color: palette.mutedGreige, minWidth: 160 }}>
          <span className="uppercase" style={{ letterSpacing: "0.14em" }}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional — defaults to code" className="block w-full font-body mt-1" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12, background: "#fff", color: palette.black }} />
        </label>
        <button type="button" disabled={pending || !code.trim()} onClick={add} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.gold, color: palette.black, padding: "9px 14px", fontWeight: 600 }}>
          <Plus size={13} /> Add
        </button>
      </div>

      <div className="mt-4">
        {visible.map((r) => (
          <div key={r.id} className="flex items-center gap-3 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", opacity: r.active ? 1 : 0.45 }}>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: palette.black, width: 90 }}>{r.code}</span>
            <span className="font-body flex-1" style={{ fontSize: 12, color: palette.softBlack }}>{r.label}</span>
            <button type="button" disabled={pending} onClick={() => toggle(r)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: r.active ? palette.mutedGreige : palette.goldDeep }}>
              {r.active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        ))}
        {visible.length === 0 && <div className="font-body py-8 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>Nothing in this list yet — the Reference importer seeds it, or add above.</div>}
      </div>

      {toast && <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase z-[60]" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>}
    </div>
  );
}
