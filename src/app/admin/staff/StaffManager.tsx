"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Copy } from "lucide-react";
import { addStaffUser, setStaffActive } from "./actions";
import { palette } from "@/lib/palette";
import type { StaffRole } from "@/lib/types";

interface RowDTO { id: string; email: string; name: string | null; role: StaffRole; active: boolean; }

const ROLE_LABEL: Record<StaffRole, string> = { super_admin: "Super Admin", admin: "Admin", staff: "Staff" };

export function StaffManager({ actor, rows }: { actor: { id: string; role: StaffRole }; rows: RowDTO[] }) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("staff");
  const [error, setError] = useState<string | null>(null);
  const [createdPw, setCreatedPw] = useState<{ email: string; password: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const canCreateAdmin = actor.role === "super_admin";
  function canManage(target: RowDTO): boolean {
    if (target.role === "super_admin" || target.id === actor.id) return false;
    if (actor.role === "super_admin") return true;
    return actor.role === "admin" && target.role === "staff";
  }

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2500); }

  function save() {
    setError(null);
    start(async () => {
      const res = await addStaffUser({ name, email, role });
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setCreatedPw({ email: email.trim().toLowerCase(), password: res.password! });
      setAdding(false); setName(""); setEmail(""); setRole("staff");
      router.refresh();
    });
  }

  function toggle(target: RowDTO) {
    const verb = target.active ? "Deactivate" : "Reactivate";
    if (!window.confirm(`${verb} ${target.name ?? target.email}?`)) return;
    start(async () => {
      const res = await setStaffActive(target.id, !target.active);
      if (!res.ok) flash(res.error ?? "Failed");
      router.refresh();
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Staff</h1>
        <button type="button" onClick={() => setAdding((v) => !v)} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "9px 16px" }}>
          <UserPlus size={13} strokeWidth={2.2} /> Add {canCreateAdmin ? "Admin / Staff" : "Staff"}
        </button>
      </div>

      {createdPw && (
        <div className="mt-4 p-3" style={{ background: palette.amberSoft, border: `1px solid ${palette.champagne}` }}>
          <div className="font-body" style={{ fontSize: 12, color: palette.softBlack }}>
            Account ready — share these once (shown only now):
          </div>
          <div className="font-body mt-1" style={{ fontSize: 13, fontWeight: 600 }}>{createdPw.email} · {createdPw.password}</div>
          <button type="button" onClick={() => { navigator.clipboard?.writeText(`${createdPw.email}\n${createdPw.password}`); flash("Copied"); }} className="flex items-center gap-1.5 font-body uppercase mt-2" style={{ border: `1px solid ${palette.black}`, fontSize: 9, letterSpacing: "0.15em", padding: "6px 11px" }}>
            <Copy size={11} /> Copy
          </button>
        </div>
      )}

      {adding && (
        <div className="mt-4 flex flex-col gap-3 max-w-sm p-4" style={{ border: "1px solid rgba(26,26,26,0.12)" }}>
          <label className="flex flex-col gap-1">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>Name *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>Email *</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
          </label>
          <div className="flex gap-1.5">
            {(["staff", ...(canCreateAdmin ? (["admin"] as const) : [])] as StaffRole[]).map((r) => (
              <button key={r} type="button" onClick={() => setRole(r)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 12px", color: role === r ? palette.ivory : palette.softBlack, background: role === r ? palette.black : "transparent", border: role === r ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{ROLE_LABEL[r]}</button>
            ))}
          </div>
          {error && <p className="font-body" style={{ fontSize: 11, color: palette.crimsonText }}>{error}</p>}
          <button type="button" onClick={save} disabled={isPending} className="font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 0" }}>
            {isPending ? "Creating…" : "Create Account"}
          </button>
        </div>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 480 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              {["Name", "Email", "Role", "Status", ""].map((h) => (
                <th key={h} className="font-body uppercase text-left" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "8px 10px", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", opacity: s.active ? 1 : 0.55 }}>
                <td className="font-body" style={{ fontSize: 13, color: palette.black, padding: "10px" }}>{s.name ?? "—"}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{s.email}</td>
                <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{ROLE_LABEL[s.role]}</td>
                <td className="font-body" style={{ fontSize: 12, color: s.active ? palette.goldDeep : palette.mutedGreige, padding: "10px" }}>{s.active ? "Active" : "Inactive"}</td>
                <td style={{ padding: "10px" }}>
                  {canManage(s) && (
                    <button type="button" onClick={() => toggle(s)} disabled={isPending} className="font-body uppercase disabled:opacity-50" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.12em", padding: "5px 10px" }}>
                      {s.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>
      )}
    </div>
  );
}
