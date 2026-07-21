"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Eye, EyeOff, Copy, MessageCircle, RefreshCw, UserPlus, Pencil, ImageOff } from "lucide-react";
import { StatusPill } from "@/components/admin/Pills";
import { CredentialModal } from "@/components/admin/CredentialModal";
import { Lightbox, ZoomImage } from "@/components/Lightbox";
import {
  setBuyerStatus,
  revealPassword,
  shareCredentials,
  regeneratePassword,
  changePassword,
  addNote,
  updateBuyerProfile,
  uploadBuyerCard,
} from "@/app/admin/buyers/actions";
import { buildWhatsAppMessage, shareWhatsApp, buildVCard, downloadVCard } from "@/lib/share";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { BuyerStatus, BuyerSource, OrderStatus, AuditEventType } from "@/lib/types";

interface BuyerDTO {
  id: string;
  email: string | null;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  gstin: string | null;
  address: string | null;
  transport_details: string | null;
  broker_details: string | null;
  other_details: string | null;
  status: BuyerStatus;
  source: BuyerSource;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  approvedByName: string | null;
  hasPassword: boolean;
  cardUrl?: string | null;
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
  const [cardZoom, setCardZoom] = useState(false);
  // Full profile edit — every stored detail plus the photo/visiting card.
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  function openEdit() {
    setEditForm({
      business_name: buyer.business_name ?? "",
      owner_name: buyer.owner_name ?? "",
      phone: buyer.phone ?? "",
      city: buyer.city ?? "",
      gstin: buyer.gstin ?? "",
      address: buyer.address ?? "",
      transport_details: buyer.transport_details ?? "",
      broker_details: buyer.broker_details ?? "",
      other_details: buyer.other_details ?? "",
    });
    setEditOpen(true);
  }
  function saveEdit() {
    start(async () => {
      const r = await updateBuyerProfile(buyer.id, editForm);
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      setEditOpen(false);
      flash("Details saved");
      router.refresh();
    });
  }
  async function onEditPhoto(file: File | null) {
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      fd.append("card", file);
      const r = await uploadBuyerCard(buyer.id, fd);
      flash(r.ok ? "Photo updated" : r.error ?? "Upload failed");
      if (r.ok) router.refresh();
    } finally {
      setUploadingPhoto(false);
    }
  }
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
    start(async () => {
      const res = await setBuyerStatus(buyer.id, next, reason);
      router.refresh();
      flash(res.ok ? `Status set to ${next}` : res.error ?? "Failed to update status");
    });
  }

  function reveal() { start(async () => { const r = await revealPassword(buyer.id); if (r.ok) setRevealed(r.password!); else flash(r.error ?? "Failed"); }); }
  function share(channel: "Copy" | "WhatsApp") {
    if (!buyer.email) { flash("Add an email before sharing"); return; }
    start(async () => {
      const r = await shareCredentials(buyer.id, channel);
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      if (channel === "Copy") {
        // Old WebViews lack navigator.clipboard — a false "Copied" toast made
        // staff paste nothing (audit fix). Fall back to execCommand and be
        // honest when both fail.
        const text = `${buyer.email}\n${r.password}`;
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fallback below */ }
        if (!ok) {
          const ta = document.createElement("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.focus(); ta.select();
          ok = document.execCommand("copy");
          ta.remove();
        }
        flash(ok ? "Copied" : "Copy failed — use Reveal and copy manually");
      }
      else await shareWhatsApp(buildWhatsAppMessage(buyer.email!, r.password!), buyer.phone);
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
            {buyer.email ?? "—"}{buyer.gstin ? ` · GSTIN ${buyer.gstin}` : ""}
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
            <div className="flex gap-2 flex-wrap justify-end">
              <button type="button" onClick={openEdit} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
                <Pencil size={12} /> Edit Details
              </button>
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

      {/* No credentials yet → set them (approves too when still pending) */}
      {isAdmin && !buyer.hasPassword && buyer.status !== "rejected" && (
        <button type="button" onClick={() => setShowModal(true)} className="mt-5 flex items-center gap-2 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 11, letterSpacing: "0.18em", padding: "11px 18px" }}>
          <UserPlus size={14} /> {buyer.status === "pending" ? "Approve & Set Credentials" : "Set Credentials"}
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

      {/* Visiting card / photo */}
      {buyer.cardUrl && (
        <section className="mt-7">
          <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Visiting Card / Photo</h2>
          <button type="button" onClick={() => setCardZoom(true)} aria-label="Enlarge visiting card" className="inline-block mt-2" style={{ cursor: "zoom-in", padding: 0, border: "none", background: "transparent" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={buyer.cardUrl} alt="Visiting card" style={{ maxWidth: 260, maxHeight: 170, objectFit: "cover", border: "1px solid rgba(26,26,26,0.15)" }} />
          </button>
          {cardZoom && <Lightbox src={buyer.cardUrl} alt="Visiting card" onClose={() => setCardZoom(false)} />}
        </section>
      )}

      {/* Details (operational) */}
      {(buyer.address || buyer.transport_details || buyer.broker_details || buyer.other_details) && (
        <section className="mt-8">
          <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Details</h2>
          <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {buyer.address && (
              <div>
                <dt className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Address</dt>
                <dd className="font-body mt-0.5" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{buyer.address}</dd>
              </div>
            )}
            {buyer.transport_details && (
              <div>
                <dt className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Transport</dt>
                <dd className="font-body mt-0.5" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{buyer.transport_details}</dd>
              </div>
            )}
            {buyer.broker_details && (
              <div>
                <dt className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Broker</dt>
                <dd className="font-body mt-0.5" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{buyer.broker_details}</dd>
              </div>
            )}
            {buyer.other_details && (
              <div>
                <dt className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Other</dt>
                <dd className="font-body mt-0.5" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{buyer.other_details}</dd>
              </div>
            )}
          </dl>
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

      {/* Full profile edit — details + photo. Email stays with the credential flow. */}
      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !isPending && setEditOpen(false)}>
          <div className="w-full sm:max-w-lg max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px", paddingBottom: "calc(20px + var(--kb-inset, 0px))" }} onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Edit Buyer</h2>

            {/* Photo / visiting card */}
            <div className="flex gap-3 mt-4 items-start">
              {buyer.cardUrl ? (
                <ZoomImage src={buyer.cardUrl} alt="Buyer photo" width={90} height={68} />
              ) : (
                <div className="flex items-center justify-center flex-shrink-0" style={{ width: 90, height: 68, background: palette.ivoryDeep }}>
                  <ImageOff size={18} color={palette.mutedGreige} />
                </div>
              )}
              <div>
                <span className="font-body uppercase block" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>Photo / Visiting Card</span>
                <label className="mt-2 inline-block font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", border: `1px solid ${palette.black}`, padding: "7px 12px", cursor: "pointer", opacity: uploadingPhoto ? 0.6 : 1 }}>
                  {uploadingPhoto ? "Uploading…" : buyer.cardUrl ? "Replace Photo" : "Add Photo"}
                  <input type="file" accept="image/*" className="hidden" disabled={uploadingPhoto} onChange={(e) => onEditPhoto(e.target.files?.[0] ?? null)} />
                </label>
              </div>
            </div>

            <div className="flex flex-col gap-3 mt-4">
              {([
                ["business_name", "Business name"],
                ["owner_name", "Owner name"],
                ["phone", "Phone"],
                ["city", "City"],
                ["gstin", "GSTIN"],
                ["address", "Address"],
                ["transport_details", "Transport details"],
                ["broker_details", "Broker details"],
                ["other_details", "Other details"],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>{label}</span>
                  <input
                    value={editForm[key] ?? ""}
                    onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="font-body bg-transparent outline-none"
                    style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13.5 }}
                  />
                </label>
              ))}
            </div>

            <div className="flex gap-2 mt-5">
              <button type="button" onClick={saveEdit} disabled={isPending} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>
                {isPending ? "Saving…" : "Save Changes"}
              </button>
              <button type="button" onClick={() => setEditOpen(false)} disabled={isPending} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px" }}>{toast}</div>
      )}
    </div>
  );
}
