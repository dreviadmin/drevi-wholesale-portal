"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Copy, MessageCircle, RefreshCw, UserPlus, Pencil, ImageOff, Undo2, Clock3 } from "lucide-react";
import { BackLink, withFrom } from "@/components/BackLink";
import { DraftNotice } from "@/components/DraftNotice";
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
  decideChangeRequest,
  type ChangeRequestRow,
} from "@/app/admin/buyers/actions";
import { buyerEditDraftKey, buyerEditSignature, type BuyerEditFields } from "@/app/admin/orders/[id]/EditBuyerButton";
import { unapplyCredit } from "@/app/admin/credit-notes/actions";
import { buildWhatsAppMessage, shareWhatsApp, buildVCard, downloadVCard } from "@/lib/share";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { useDraft } from "@/lib/useDraft";
import { ORDER_STATUS_LABEL } from "@/lib/order-status";
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
type BuyerEditForm = BuyerEditFields & { other_details: string };
interface OrderDTO { id: string; order_number: string; total_amount: number; status: OrderStatus; submitted_at: string; }
interface ActivityDTO { event_type: AuditEventType; event_at: string; notes: string | null; staffName: string | null; }

// Wallet (11 Sep). A credit note IS the grant, so the grants come from
// credit_notes and credit_ledger carries consumption only; consumed/remaining
// per note is the FIFO allocation computed server-side.
interface WalletNoteDTO {
  id: string; note_number: string; kind: string; note_date: string; created_at: string;
  total: number; status: string; reason: string;
  order_id: string | null; source_bill_number: string | null;
  consumed: number; remaining: number;
}
interface WalletEntryDTO {
  id: string; delta: number; reason: string; note: string | null;
  ref_type: string | null; ref_id: string | null;
  effective_date: string; created_at: string; orderNumber: string | null;
}
export interface WalletDTO { balance: number; notes: WalletNoteDTO[]; entries: WalletEntryDTO[] }

// One timeline row: a grant (an issued note) or a consumption entry, in the
// order the FIFO allocator uses so the running balance reconciles to the card.
interface WalletEvent {
  key: string; date: string; createdAt: string; delta: number;
  title: string; sub: string;
  href: string | null; pdfHref: string | null;
  undoEntryId: string | null; voided: boolean;
}

const EVENT_LABEL: Record<string, string> = {
  credential_created: "Credentials created", credential_viewed: "Password viewed", credential_regenerated: "Password regenerated",
  credential_changed: "Password changed", credential_shared: "Credentials shared", login_success: "Login", login_failed: "Failed login",
  account_suspended: "Suspended", account_reactivated: "Reactivated", account_rejected: "Rejected",
};
const SOURCE_LABEL: Record<BuyerSource, string> = { inquiry_form: "Inquiry", exhibition: "Exhibition", manual_admin: "Manual" };
// Same wording the buyer sees on /account/details, so both sides name the same thing.
const IDENTITY_LABEL: Record<ChangeRequestRow["field"], string> = { business_name: "Business name", gstin: "GSTIN" };
const DECISION_LABEL: Record<ChangeRequestRow["status"], string> = { pending: "Waiting", approved: "Approved", rejected: "Refused", withdrawn: "Withdrawn by the buyer" };
function fmt(iso: string | null) { return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"; }
function fmtTime(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }
// note_date / effective_date are DATE columns — pinned to IST noon so a device
// behind UTC doesn't render the day before.
function fmtDay(day: string) { return new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }

export function BuyerDetail({ isAdmin, buyer, orders, activity, wallet, changeRequests }: { isAdmin: boolean; buyer: BuyerDTO; orders: OrderDTO[]; activity: ActivityDTO[]; wallet: WalletDTO; changeRequests: ChangeRequestRow[] }) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [showModal, setShowModal] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [cardZoom, setCardZoom] = useState(false);
  // Full profile edit — every stored detail plus the photo/visiting card.
  // The draft (open flag + fields) is shared with the order page's Edit button.
  const editSeed: BuyerEditForm = {
    business_name: buyer.business_name ?? "",
    owner_name: buyer.owner_name ?? "",
    phone: buyer.phone ?? "",
    city: buyer.city ?? "",
    gstin: buyer.gstin ?? "",
    address: buyer.address ?? "",
    transport_details: buyer.transport_details ?? "",
    broker_details: buyer.broker_details ?? "",
    other_details: buyer.other_details ?? "",
  };
  const [edit, setEdit, editMeta] = useDraft<{ open: boolean; form: BuyerEditForm }>(
    buyerEditDraftKey(buyer.id),
    { open: false, form: editSeed },
    {
      enabled: isAdmin, // Edit Details is admin-only; a shared shop device must not reopen an admin draft for staff
      hasContent: (d) => d.open,
      base: buyerEditSignature(editSeed),
      // A draft from the order page has no other_details; fill it from the server so saving here keeps it.
      onRestore: (d) => ({ ...d, form: { ...editSeed, ...d.form } }),
    },
  );
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  function openEdit() {
    setEdit((d) => (editMeta.restored ? { ...d, open: true } : { open: true, form: editSeed }));
  }
  function closeEdit() {
    editMeta.clear();
    setEdit({ open: false, form: editSeed });
  }
  // Discard / Use server keep the modal open on the current server values.
  const editNotice = { ...editMeta, discard: () => { editMeta.clear(); setEdit({ open: true, form: editSeed }); } };
  // Only the fields the staff ACTUALLY edited are sent. The form is seeded from
  // the row as it was rendered, so posting the whole form pushes those stale
  // values back — silently reverting a change the buyer got approved while this
  // page sat open (migration 0048). Trimmed both sides: whitespace is not an edit.
  function editedFields(form: BuyerEditForm): Partial<BuyerEditForm> {
    const patch: Partial<BuyerEditForm> = {};
    for (const key of Object.keys(editSeed) as (keyof BuyerEditForm)[]) {
      if (form[key].trim() !== editSeed[key].trim()) patch[key] = form[key];
    }
    return patch;
  }
  function saveEdit() {
    const patch = editedFields(edit.form);
    if (Object.keys(patch).length === 0) { closeEdit(); flash("Nothing changed"); return; }
    start(async () => {
      const r = await updateBuyerProfile(buyer.id, patch);
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      closeEdit();
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
  const [notes, setNotes, notesMeta] = useDraft(`drevi:draft:buyer-notes:${buyer.id}`, buyer.notes ?? "", {
    enabled: isAdmin,
    base: buyer.notes ?? "",
    hasContent: (n) => n !== (buyer.notes ?? ""),
  });
  const [editingNotes, setEditingNotes] = useState(false);
  // A restored draft reopens the composer so it is never mistaken for the saved notes.
  useEffect(() => { if (notesMeta.restored) setEditingNotes(true); }, [notesMeta.restored]);

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

  // ---- Identity change requests --------------------------------------------
  // business_name and gstin print on every GST tax invoice, so the buyer may
  // ask for them but only staff may set them (migration 0048). Every guard —
  // already decided, buyer suspended, the value having drifted since they
  // asked — lives in the server RPC, and its refusals are sentences written
  // for a person, so they are shown word for word instead of being replaced.
  const [requestError, setRequestError] = useState<string | null>(null);
  const pendingRequests = changeRequests.filter((r) => r.status === "pending");
  // Withdrawn ones are the buyer changing their mind, not a decision staff made,
  // so they sit at the bottom of the settled list and read muted.
  const settledRequests = changeRequests
    .filter((r) => r.status !== "pending")
    .sort((a, b) => Number(a.status === "withdrawn") - Number(b.status === "withdrawn"))
    .slice(0, 6);

  function decideRequest(req: ChangeRequestRow, decision: "approved" | "rejected") {
    const label = IDENTITY_LABEL[req.field];
    let note: string | undefined;
    if (decision === "rejected") {
      const reason = window.prompt(`Why is the ${label} change to "${req.requested_value}" being refused? (the buyer sees this)`);
      if (reason === null) return;
      if (!reason.trim()) { setRequestError("Give a reason — the buyer sees it."); return; }
      note = reason.trim();
    } else if (!window.confirm(`Set ${label} to "${req.requested_value}"? Every invoice issued from now on carries it.`)) {
      return;
    }
    setRequestError(null);
    start(async () => {
      const r = await decideChangeRequest(req.id, decision, note);
      if (!r.ok) { setRequestError(r.error ?? "Failed"); return; }
      flash(decision === "approved" ? `${label} updated` : "Request refused");
      router.refresh();
    });
  }

  // ---- Wallet ---------------------------------------------------------------
  const here = `/admin/buyers/${buyer.id}`;
  // An application that has already been reversed carries an 'unapplied' row
  // pointing back at it, and the DB allows exactly one — so Undo disappears
  // rather than failing on the second tap.
  const reversedEntryIds = new Set(
    wallet.entries
      .filter((e) => e.reason === "unapplied" && e.ref_type === "credit_ledger" && e.ref_id)
      .map((e) => e.ref_id as string),
  );
  const walletEvents: WalletEvent[] = [
    ...wallet.notes.map((n) => ({
      key: `note:${n.id}`,
      date: n.note_date,
      createdAt: n.created_at,
      // A voided note grants nothing; it stays in the history as the record.
      delta: n.status === "issued" ? n.total : 0,
      title: `${n.note_number} · ${n.kind === "return" ? "Return" : "Manual credit"}`,
      sub: [n.reason, n.source_bill_number ? `against ${n.source_bill_number}` : null].filter(Boolean).join(" · "),
      href: n.order_id ? withFrom(`/admin/orders/${n.order_id}`, here) : withFrom(`/admin/credit-notes?q=${encodeURIComponent(n.note_number)}`, here),
      pdfHref: `/api/credit-notes/${n.id}/pdf`,
      undoEntryId: null,
      voided: n.status !== "issued",
    })),
    ...wallet.entries.map((e) => ({
      key: `entry:${e.id}`,
      date: e.effective_date,
      createdAt: e.created_at,
      delta: e.delta,
      title:
        e.reason === "applied"
          ? `Applied to ${e.orderNumber ?? "an order"}`
          : e.reason === "unapplied"
            ? `Reversed — ${e.orderNumber ?? "order"}`
            : "Refunded in cash",
      sub: e.note ?? "",
      href: e.ref_type === "order" && e.ref_id ? withFrom(`/admin/orders/${e.ref_id}`, here) : null,
      pdfHref: null,
      undoEntryId: e.reason === "applied" && !reversedEntryIds.has(e.id) ? e.id : null,
      voided: false,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  let running = 0;
  const walletRows = walletEvents.map((ev) => {
    running = Math.round((running + ev.delta) * 100) / 100;
    return { ...ev, balance: running };
  });
  const openNotes = wallet.notes.filter((n) => n.status === "issued");

  function undoApplication(entryId: string, title: string) {
    if (!window.confirm(`Undo "${title}"? The credit goes back to this party's wallet and the order's balance due rises again.`)) return;
    start(async () => {
      const r = await unapplyCredit(entryId);
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      flash("Credit returned to the wallet");
      router.refresh();
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl">
      <BackLink fallback="/admin/buyers" fallbackLabel="Buyers" />

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

      {/* Identity changes the buyer asked for on /account/details. Only shown
          when there is something to show — most parties never ask. */}
      {(pendingRequests.length > 0 || settledRequests.length > 0) && (
        <section
          className="mt-6"
          style={{
            border: `1px solid ${pendingRequests.length > 0 ? palette.champagne : "rgba(26,26,26,0.14)"}`,
            background: pendingRequests.length > 0 ? palette.amberSoft : palette.ivoryDeep,
            padding: "14px 16px",
          }}
        >
          <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>
            Identity Changes
          </div>

          {pendingRequests.length === 0 ? (
            <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
              Nothing waiting.
            </p>
          ) : (
            <>
              <p className="font-body mt-1.5" style={{ fontSize: 11, color: palette.goldDeep, lineHeight: 1.6, maxWidth: 460 }}>
                These print on every GST tax invoice. Decide them here — editing the same field through Edit Details
                leaves the request stale and the server then refuses it.
              </p>
              {pendingRequests.map((r) => (
                <div key={r.id} className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>
                      {IDENTITY_LABEL[r.field]}
                    </div>
                    <div className="flex items-center gap-1.5 font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                      <Clock3 size={11} strokeWidth={1.8} /> Asked {fmtTime(r.requested_at)}
                    </div>
                  </div>
                  <div className="font-body mt-1.5" style={{ fontSize: 12, color: palette.mutedGreige }}>
                    Now: {r.before_value || "not on file"}
                  </div>
                  <div className="font-body mt-0.5" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>
                    Asked for: {r.requested_value}
                  </div>
                  {r.buyer_note && (
                    <div className="font-body mt-1.5" style={{ fontSize: 12, color: palette.softBlack, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                      “{r.buyer_note}”
                    </div>
                  )}
                  {isAdmin ? (
                    <div className="flex gap-2 mt-3 flex-wrap">
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => decideRequest(r, "approved")}
                        className="font-body uppercase disabled:opacity-40"
                        style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => decideRequest(r, "rejected")}
                        className="font-body uppercase disabled:opacity-40"
                        style={{ border: `1px solid ${palette.crimsonText}`, color: palette.crimsonText, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <p className="font-body mt-2" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                      An admin decides this one.
                    </p>
                  )}
                </div>
              ))}
            </>
          )}

          {/* The server writes these for a human — drift, suspension — so they
              are printed as they arrive rather than flattened into a toast. */}
          {requestError && (
            <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText, lineHeight: 1.6, maxWidth: 460 }}>
              {requestError}
            </p>
          )}

          {settledRequests.length > 0 && (
            <div className="mt-4">
              <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Already handled</div>
              {settledRequests.map((r) => (
                <div
                  key={r.id}
                  className="font-body py-1.5"
                  style={{ fontSize: 11, color: palette.softBlack, lineHeight: 1.6, borderBottom: "1px solid rgba(26,26,26,0.07)", opacity: r.status === "withdrawn" ? 0.5 : 1 }}
                >
                  <b style={{ fontWeight: 600, color: r.status === "approved" ? palette.goldDeep : r.status === "rejected" ? palette.crimsonText : palette.mutedGreige }}>
                    {DECISION_LABEL[r.status]}
                  </b>
                  {" · "}{IDENTITY_LABEL[r.field]} → {r.requested_value}
                  {r.decision_note ? ` · ${r.decision_note}` : ""}
                  <span style={{ color: palette.mutedGreige }}> · {fmtTime(r.decided_at ?? r.requested_at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Wallet — credit this party holds. The balance is derived from issued
          notes less consumption, so it can never drift from the documents. */}
      <section
        className="mt-6"
        style={{
          border: `1px solid ${wallet.balance < 0 ? palette.crimsonBorder : "rgba(26,26,26,0.14)"}`,
          background: wallet.balance < 0 ? palette.crimsonSoft : palette.ivoryDeep,
          padding: "14px 16px",
        }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Wallet</div>
            {wallet.balance < 0 ? (
              <>
                <div className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.crimsonText, marginTop: 5 }}>
                  OVERDRAWN — investigate
                </div>
                <div className="font-body" style={{ fontSize: 12, color: palette.crimsonText, marginTop: 3, lineHeight: 1.6, maxWidth: 460 }}>
                  {formatINR(Math.abs(wallet.balance))} more credit has been spent than was ever granted. Undo an
                  application below, or issue the credit note that should have backed it.
                </div>
              </>
            ) : (
              <>
                <div className="font-display" style={{ fontSize: 30, fontWeight: 600, color: palette.black, marginTop: 4 }}>
                  {formatINR(wallet.balance)}
                </div>
                <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige, marginTop: 2 }}>
                  Unspent credit · {openNotes.length} open note{openNotes.length === 1 ? "" : "s"}
                </div>
              </>
            )}
          </div>
          {isAdmin && (
            <div className="flex gap-2 flex-wrap justify-end">
              <Link href={withFrom(`/admin/credit-notes/new?buyer=${buyer.id}`, here)} className="font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
                Issue Credit Note
              </Link>
              <Link href={withFrom("/admin/credit-notes", here)} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
                Credit Register
              </Link>
            </div>
          )}
        </div>

        {/* Per note: how much of THIS credit is left. */}
        {openNotes.length > 0 && (
          <div className="mt-4">
            <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Open notes</div>
            {openNotes.map((n) => (
              <div key={n.id} className="flex items-center justify-between gap-3 py-1.5 flex-wrap" style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
                <span className="font-body" style={{ fontSize: 11.5, color: palette.black }}>
                  {n.note_number}
                  <span style={{ color: palette.mutedGreige }}> · {fmtDay(n.note_date)}</span>
                </span>
                <span className="font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
                  {formatINR(n.total)} issued · {formatINR(n.consumed)} used ·{" "}
                  <b style={{ color: n.remaining > 0 ? palette.goldDeep : palette.mutedGreige }}>{formatINR(n.remaining)} left</b>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* History, oldest first, so the running balance ends on the number above. */}
        <div className="mt-4">
          <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>History</div>
          {walletRows.length === 0 ? (
            <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: palette.mutedGreige }}>
              No credit yet — a return or a manual note starts the wallet.
            </p>
          ) : walletRows.map((r) => (
            <div key={r.key} className="flex items-start justify-between gap-3 py-2 flex-wrap" style={{ borderBottom: "1px solid rgba(26,26,26,0.07)", opacity: r.voided ? 0.55 : 1 }}>
              <div className="min-w-0">
                <div className="font-body" style={{ fontSize: 12, color: palette.black }}>
                  {r.href ? (
                    <Link href={r.href} style={{ borderBottom: `1px solid ${palette.gold}` }}>{r.title}</Link>
                  ) : r.title}
                  {r.voided && <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.12em", color: palette.crimsonText, marginLeft: 8 }}>VOIDED</span>}
                </div>
                <div className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                  {fmtDay(r.date)}{r.sub ? ` · ${r.sub}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-body" style={{ fontSize: 12, color: r.delta > 0 ? palette.goldDeep : r.delta < 0 ? palette.crimsonText : palette.mutedGreige }}>
                  {r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}{formatINR(Math.abs(r.delta))}
                </span>
                <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: r.balance < 0 ? palette.crimsonText : palette.black, minWidth: 72, textAlign: "right" }}>
                  {formatINR(r.balance)}
                </span>
                {r.pdfHref && (
                  <a href={r.pdfHref} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>PDF</a>
                )}
                {isAdmin && r.undoEntryId && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => undoApplication(r.undoEntryId!, r.title)}
                    className="flex items-center gap-1 font-body uppercase disabled:opacity-40"
                    style={{ fontSize: 8.5, letterSpacing: "0.1em", color: palette.mutedGreige }}
                  >
                    <Undo2 size={11} /> Undo
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

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
            <Link key={o.id} href={withFrom(`/admin/orders/${o.id}`, `/admin/buyers/${buyer.id}`)} className="flex items-center justify-between py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
              <span className="font-body" style={{ fontSize: 12.5, color: palette.black }}>{o.order_number} · {fmt(o.submitted_at)}</span>
              <span className="font-body" style={{ fontSize: 12.5, color: palette.softBlack }}>{formatINR(o.total_amount)} · {ORDER_STATUS_LABEL[o.status]}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Notes */}
      <section className="mt-8">
        <h2 className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Notes</h2>
        {editingNotes ? (
          <div className="mt-2">
            {notesMeta.restored && <div className="mb-2"><DraftNotice meta={notesMeta} /></div>}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: 8, fontSize: 12.5 }} />
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={() => start(async () => { await addNote(buyer.id, notes); notesMeta.clear(); setEditingNotes(false); router.refresh(); flash("Notes saved"); })} className="font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px" }}>Save</button>
              <button type="button" onClick={() => { notesMeta.clear(); setNotes(buyer.notes ?? ""); setEditingNotes(false); }} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px" }}>Cancel</button>
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
      {edit.open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.5)" }} onClick={() => !isPending && closeEdit()}>
          <div className="w-full sm:max-w-lg max-h-modal overflow-y-auto" style={{ background: palette.ivory, padding: "20px 18px", paddingBottom: "calc(20px + var(--kb-inset, 0px))" }} onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Edit Buyer</h2>
            {editMeta.restored && <div className="mt-3"><DraftNotice meta={editNotice} /></div>}

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
                    value={edit.form[key]}
                    onChange={(e) => setEdit((d) => ({ ...d, form: { ...d.form, [key]: e.target.value } }))}
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
              <button type="button" onClick={closeEdit} disabled={isPending} className="font-body uppercase px-5" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
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
