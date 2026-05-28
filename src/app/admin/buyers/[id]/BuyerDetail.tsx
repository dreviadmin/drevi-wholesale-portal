"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Eye, EyeOff, Copy, MessageCircle, RefreshCw, UserPlus } from "lucide-react";
import { StatusPill } from "@/components/admin/Pills";
import { CredentialModal } from "@/components/admin/CredentialModal";
import {
  setBuyerStatus,
  revealPassword,
  shareCredentials,
  regeneratePassword,
  changePassword,
  addNote,
} from "@/app/admin/buyers/actions";
import { buildWhatsAppMessage, shareWhatsApp, buildVCard, downloadVCard } from "@/lib/share";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { BuyerStatus, BuyerSource, OrderStatus, AuditEventType } from "@/lib/types";

interface BuyerDTO {
  id: string;
  email: string;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  gstin: string | null;
  status: BuyerStatus;
  source: BuyerSource;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  approvedByName: string | null;
  hasPassword: boolean;
}
interface OrderDTO { id: string; order_number: string; total_amount: number; status: OrderStatus; submitted_at: string; }
interface ActivityDTO { event_type: AuditEventType; event_at: string; notes: string | null; staffName: string | null; }

const EVENT_LABEL: Record<string, string> = {
  credential_created: "Credentials created", credential_viewed: "Password viewed", credential_regenerated: "Password regenerated",
  credential_changed: "Password changed", credential_shared: "Credentials shared", login_success: "Login", login_failed: "Failed login",
  account_suspended: "Suspended", account_reactivated: "Reactivated", account_rejected: "Rejected",
};
const SOURCE_LABEL: Record<BuyerSource, string> = { inquiry_form: "Inquiry", exhibition: "Exhibition", manual_admin: "Manual" };
function fmt(iso: string | null) { return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"; }
function fmtTime(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }

export function BuyerDetail({ isAdmin, buyer, orders, activity }: { isAdmin: boolean; buyer: BuyerDTO; orders: OrderDTO[]; activity: ActivityDTO[] }) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [showModal, setShowModal] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [notes, setNotes] = useState(buyer.notes ?? "");
  const [editingNotes, setEditingNotes] = useState(false);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2500); }

  function changeStatus(next: BuyerStatus) {
    if (next === buyer.status) return;
    let reason: string | undefined;
    if (next === "rejected") {
      const r = window.prompt("Reason for rejecting this buyer? (recorded, no message sent)");
      if (r === null) return;
      reason = r;
    } else if (!window.confirm(`Change status to ${next}?`)) return;
    start(async () => { await setBuyerStatus(buyer.id, next, reason); router.refresh(); flash(`Status set to ${next}`); });
  }

  function reveal() { start(async () => { const r = await revealPassword(buyer.id); if (r.ok) setRevealed(r.password!); else flash(r.error ?? "Failed"); }); }
  function share(channel: "Copy" | "WhatsApp") {
    start(async () => {
      const r = await shareCredentials(buyer.id, channel);
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      if (channel === "Copy") { await navigator.clipboard?.writeText(`${buyer.email}\n${r.password}`); flash("Copied"); }
      else await shareWhatsApp(buildWhatsAppMessage(buyer.email, r.password!), buyer.phone);
    });
  }
  function regenerate() {
    if (!window.confirm("Generate a new password and invalidate the current one?")) return;
    start(async () => { const r = await regeneratePassword(buyer.id); if (r.ok) { setRevealed(r.password!); flash("New password generated"); } else flash(r.error ?? "Failed"); });
  }
  function submitChange() {
    start(async () => { const r = await changePassword(buyer.id, newPw); if (r.ok) { setRevealed(r.password!); setChanging(false); setNewPw(""); flash("Password changed"); } else flash(r.error ?? "Failed"); });
  }
  function saveVCard() {
    downloadVCard(buildVCard({ ownerName: buyer.owner_name, businessName: buyer.business_name, phone: buyer.phone, email: buyer.email, city: buyer.city, status: buyer.status, onboarded: buyer.approved_at ?? buyer.created_at }), `${(buyer.owner_name ?? buyer.business_name ?? "buyer").replace(/\s+/g, "-")}.vcf`);
  }
  function sendLoginLink() { share("WhatsApp"); }

  const totalSpend = orders.reduce((s, o) => s + o.total_amount, 0);

  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl">
      <Link href="/admin/buyers" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Buyers
      </Link>

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display" style={{ fontSize: 24, fontWeight: 600, color: palette.black }}>{buyer.business_name ?? "—"}</h1>
            <StatusPill status={buyer.status} />
          </div>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>
            {[buyer.owner_name, buyer.phone, buyer.city].filter(Boolean).join(" · ")}
          </div>
          <div className="font-body mt-0.5" style={{ fontSize: 12, color: palette.mutedGreige }}>
            {buyer.email}{buyer.gstin ? ` · GSTIN ${buyer.gstin}` : ""}
          </div>
          <div className="font-body mt-1.5" style={{ fontSize: 10.5, color: palette.mutedGreige, letterSpacing: "0.04em" }}>
            Source: {SOURCE_LABEL[buyer.source]}{buyer.approved_at ? ` · Approved ${fmt(buyer.approved_at)}${buyer.approvedByName ? ` by ${buyer.approvedByName}` : ""}` : ""}
          </div>
        </div>

        {isAdmin && (
          <div className="flex flex-col items-end gap-2">
            <label className="flex items-center gap-2">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.15em", color: palette.mutedGreige }}>Status</span>
              <select value={buyer.status} onChange={(e) => changeStatus(e.target.value as BuyerStatus)} className="font-body" style={{ fontSize: 12, padding: "5px 8px", border: "1px solid rgba(26,26,26,0.2)", background: palette.ivory }}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="rejected">Rejected</option>
                {buyer.status === "pending" && <option value="pending">Pending</option>}
              </select>
            </label>
            <div className="flex gap-2">
              {buyer.hasPassword && (
                <button type="button" onClick={sendLoginLink} className="flex items-center gap-1.5 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
                  <MessageCircle size={12} /> Send Login Link
                </button>
              )}
              <button type="button" onClick={saveVCard} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>Save to Contacts</button>
            </div>
          </div>
        )}
      </div>

      {/* Pending → approve */}
      {isAdmin && buyer.status === "pending" && (
        <button type="button" onClick={() => setShowModal(true)} className="mt-5 flex items-center gap-2 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 11, letterSpacing: "0.18em", padding: "11px 18px" }}>
          <UserPlus size={14} /> Approve &amp; Set Credentials
        </button>
      )}

      {/* Credentials */}
      {isAdmin && buyer.hasPassword && (
        <section className="mt-7">
          <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Credentials</h2>
          <div className="mt-3 font-body" style={{ fontSize: 13, color: palette.black }}>
            <div>Email: {buyer.email}</div>
            <div className="flex items-center gap-2 mt-1.5">
              Password: <span style={{ fontWeight: 600 }}>{revealed ?? "●●●●●●●●●●●●●"}</span>
              <button type="button" onClick={reveal} aria-label="Reveal" style={{ color: palette.mutedGreige }}>{revealed ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </div>
          <div className="flex gap-2 mt-3 flex-wrap">
            <button type="button" onClick={() => share("Copy")} className="flex items-center gap-1.5 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}><Copy size={12} /> Copy</button>
            <button type="button" onClick={() => share("WhatsApp")} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}><MessageCircle size={12} /> Share via WhatsApp</button>
            <button type="button" onClick={regenerate} className="flex items-center gap-1.5 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}><RefreshCw size={12} /> Regenerate</button>
            <button type="button" onClick={() => setChanging((v) => !v)} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>Change</button>
          </div>
          {changing && (
            <div className="flex items-center gap-2 mt-3">
              <input value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password" className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
              <button type="button" onClick={submitChange} disabled={isPending || newPw.length < 6} className="font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px" }}>Save</button>
            </div>
          )}
        </section>
      )}

      {/* Orders */}
      <section className="mt-8">
        <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>
          Order History ({orders.length}{orders.length ? ` · ${formatINR(totalSpend)} total` : ""})
        </h2>
        <div className="mt-2">
          {orders.length === 0 ? (
            <p className="font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No orders yet.</p>
          ) : orders.map((o) => (
            <Link key={o.id} href={`/admin/orders/${o.id}`} className="flex items-center justify-between py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
              <span className="font-body" style={{ fontSize: 12.5, color: palette.black }}>{o.order_number} · {fmt(o.submitted_at)}</span>
              <span className="font-body" style={{ fontSize: 12.5, color: palette.softBlack }}>{formatINR(o.total_amount)} · {o.status}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Notes */}
      <section className="mt-8">
        <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Notes</h2>
        {editingNotes ? (
          <div className="mt-2">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: 8, fontSize: 12.5 }} />
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={() => start(async () => { await addNote(buyer.id, notes); setEditingNotes(false); router.refresh(); flash("Notes saved"); })} className="font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px" }}>Save</button>
              <button type="button" onClick={() => { setNotes(buyer.notes ?? ""); setEditingNotes(false); }} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px" }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="mt-2">
            <p className="font-body" style={{ fontSize: 12.5, color: notes ? palette.softBlack : palette.mutedGreige, lineHeight: 1.6 }}>{notes || "No notes."}</p>
            {isAdmin && <button type="button" onClick={() => setEditingNotes(true)} className="font-body uppercase mt-1" style={{ fontSize: 9, letterSpacing: "0.15em", color: palette.goldDeep }}>{notes ? "Edit" : "Add note"}</button>}
          </div>
        )}
      </section>

      {/* Activity */}
      <section className="mt-8">
        <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Activity</h2>
        <div className="mt-2 flex flex-col gap-1.5">
          {activity.length === 0 ? (
            <p className="font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No activity yet.</p>
          ) : activity.map((a, i) => (
            <div key={i} className="font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
              • {EVENT_LABEL[a.event_type] ?? a.event_type}{a.notes ? ` (${a.notes})` : ""}{a.staffName ? ` by ${a.staffName}` : ""} — {fmtTime(a.event_at)}
            </div>
          ))}
        </div>
      </section>

      {showModal && (
        <CredentialModal
          buyerId={buyer.id}
          buyer={{ email: buyer.email, owner_name: buyer.owner_name, business_name: buyer.business_name, phone: buyer.phone }}
          onClose={(activated) => { setShowModal(false); if (activated) router.refresh(); }}
        />
      )}

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>
      )}
    </div>
  );
}
