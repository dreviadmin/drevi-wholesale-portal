"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Search, Plus, MessageCircle } from "lucide-react";
import { StatusPill, SourcePill } from "@/components/admin/Pills";
import { useSort, SortTh, type SortAccessor } from "@/components/sortable";
import { palette } from "@/lib/palette";
import type { BuyerStatus, BuyerSource } from "@/lib/types";
import { sendCredentialsBatch } from "./actions";

export interface BuyerRowDTO {
  id: string;
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
  email: string | null;
  status: BuyerStatus;
  source: BuyerSource;
  created_at: string;
  ordersCount: number;
  /** Has an undecided business_name / gstin change request. */
  pendingIdentity?: boolean;
  lastOrder: string | null;
  /** Active, has a phone, and has a stored password — i.e. the WhatsApp send
   *  will actually reach somebody. Computed server-side; the password itself
   *  never crosses. */
  canSend?: boolean;
}

// Each send is one Interakt call with an 8s timeout, inside a 60s function —
// six per round trip leaves headroom. The server caps at the same number, so
// a selection is chunked here rather than truncated there.
const CRED_CHUNK = 6;

const STATUSES: BuyerStatus[] = ["pending", "active", "suspended", "rejected"];
const SOURCES: BuyerSource[] = ["inquiry_form", "exhibition", "manual_admin"];
const SOURCE_LABEL: Record<BuyerSource, string> = { inquiry_form: "Inquiry", exhibition: "Exhibition", manual_admin: "Manual" };

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—";
}
// Numeric on purpose: useSort compares strings with localeCompare({numeric:true}),
// which mis-orders ISO stamps whose fractional-second digits differ in length.
function ts(iso: string | null): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}
function waLink(phone: string | null): string | null {
  if (!phone) return null;
  // 10-digit numbers (inquiry-form buyers) need the country code or wa.me
  // rejects the link (audit fix).
  let digits = phone.replace(/[^\d]/g, "").replace(/^0+/, "");
  if (digits.length === 10) digits = "91" + digits;
  return digits ? `https://wa.me/${digits}` : null;
}

const ACCESSORS: Record<string, SortAccessor<BuyerRowDTO>> = {
  business: (r) => r.business_name,
  owner: (r) => r.owner_name,
  phone: (r) => r.phone,
  city: (r) => r.city,
  status: (r) => r.status,
  source: (r) => SOURCE_LABEL[r.source],
  orders: (r) => r.ordersCount,
  lastOrder: (r) => ts(r.lastOrder),
  created: (r) => ts(r.created_at),
};

export function BuyersTable({
  rows,
  initialStatus = null,
  initialRequestsOnly = false,
}: {
  rows: BuyerRowDTO[];
  initialStatus?: string | null;
  initialRequestsOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  // Seeded from the URL so the cockpit's deep links actually land somewhere
  // useful. Staff can clear the chips as normal afterwards.
  const [statusFilter, setStatusFilter] = useState<Set<BuyerStatus>>(
    () => (initialStatus ? new Set([initialStatus as BuyerStatus]) : new Set()),
  );
  const [requestsOnly, setRequestsOnly] = useState(initialRequestsOnly);
  const [sourceFilter, setSourceFilter] = useState<Set<BuyerSource>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pendingCount = useMemo(() => rows.filter((r) => r.status === "pending").length, [rows]);
  const identityWaiting = useMemo(() => rows.filter((r) => r.pendingIdentity).length, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (requestsOnly && !r.pendingIdentity) return false;
      if (statusFilter.size && !statusFilter.has(r.status)) return false;
      if (sourceFilter.size && !sourceFilter.has(r.source)) return false;
      if (!q) return true;
      return [r.business_name, r.owner_name, r.phone, r.email].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, query, statusFilter, sourceFilter, requestsOnly]);

  function toggle<T>(set: Set<T>, value: T, setter: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const { sorted, sort, toggle: toggleSort } = useSort(filtered, ACCESSORS, { key: "created", dir: "desc" });

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3200); }

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  // What will actually go out, as against what is ticked. Shown before the
  // send, not reported after it, so nobody hits the button expecting 40
  // messages and gets 12.
  const sendable = useMemo(() => chosen.filter((r) => r.canSend), [chosen]);

  function sendCredentials() {
    const ids = sendable.map((r) => r.id);
    if (!ids.length) return;
    const held = chosen.length - ids.length;
    if (!window.confirm(
      `Send login details over WhatsApp to ${ids.length} buyer${ids.length > 1 ? "s" : ""}?` +
      (held ? ` ${held} of the ${chosen.length} selected will be left out — not active, or no phone/password on file.` : "") +
      ` Sent in batches of ${CRED_CHUNK} — leave this tab open.`,
    )) return;
    start(async () => {
      let sent = 0, skipped = 0, failed = 0, done = 0;
      let firstError: string | undefined;
      for (let i = 0; i < ids.length; i += CRED_CHUNK) {
        const chunk = ids.slice(i, i + CRED_CHUNK);
        const res = await sendCredentialsBatch(chunk);
        if (!res.ok) { flash(res.error ?? "Failed"); return; }
        sent += res.sent ?? 0; skipped += res.skipped ?? 0; failed += res.failed ?? 0;
        done += chunk.length;
        if (!firstError && res.firstError) firstError = res.firstError;
        flash(`WhatsApp ${done}/${ids.length} · ${sent} sent${skipped ? ` · ${skipped} not configured` : ""}${failed ? ` · ${failed} failed` : ""}`);
      }
      // `skipped` means INTERAKT_API_KEY is absent — the send is a logged
      // no-op. Saying so plainly beats a silent "0 sent".
      flash(
        skipped === done
          ? `Nothing went out — WhatsApp (Interakt) is not configured yet on this deployment.`
          : `Done: ${sent} sent${skipped ? ` · ${skipped} not configured` : ""}${failed ? ` · ${failed} failed` : ""}${firstError ? ` — ${firstError}` : ""}`,
      );
      if (sent > 0) setSelected(new Set());
    });
  }

  const chip = (active: boolean) => ({
    fontSize: 9,
    letterSpacing: "0.14em",
    padding: "5px 10px",
    color: active ? palette.ivory : palette.softBlack,
    background: active ? palette.black : "transparent",
    border: active ? "none" : "1px solid rgba(26,26,26,0.18)",
  });

  return (
    <div className="px-4 md:px-8 py-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Buyers</h1>
        <Link href="/admin/buyers/new" className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "9px 16px" }}>
          <Plus size={13} strokeWidth={2.5} /> Add Buyer
        </Link>
      </div>

      {pendingCount > 0 && (
        <button
          type="button"
          onClick={() => setStatusFilter(new Set(["pending"]))}
          className="mt-3 font-body"
          style={{ fontSize: 11, color: palette.goldDeep, letterSpacing: "0.04em" }}
        >
          {pendingCount} pending buyer{pendingCount > 1 ? "s" : ""} — review →
        </button>
      )}

      {/* Controls */}
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex items-center gap-2" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px", maxWidth: 360 }}>
          <Search size={15} strokeWidth={1.7} color={palette.mutedGreige} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search business, owner, phone, email"
            className="font-body bg-transparent outline-none w-full"
            style={{ fontSize: 12, color: palette.black }}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {STATUSES.map((s) => (
            <button key={s} type="button" onClick={() => toggle(statusFilter, s, setStatusFilter)} className="font-body uppercase" style={chip(statusFilter.has(s))}>{s}</button>
          ))}
          <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px" }} />
          {SOURCES.map((s) => (
            <button key={s} type="button" onClick={() => toggle(sourceFilter, s, setSourceFilter)} className="font-body uppercase" style={chip(sourceFilter.has(s))}>{SOURCE_LABEL[s]}</button>
          ))}
          {identityWaiting > 0 && (
            <>
              <span style={{ width: 1, background: "rgba(26,26,26,0.15)", margin: "0 4px" }} />
              {/* Visible and toggleable, so a filter arriving from the cockpit's
                  deep link can always be cleared without editing the URL. */}
              <button
                type="button"
                onClick={() => setRequestsOnly((v) => !v)}
                className="font-body uppercase"
                style={chip(requestsOnly)}
              >
                Identity {identityWaiting}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Select-all covers the FILTERED rows, never the whole book — the point
          of narrowing to, say, Exhibition is to act on exactly those, and a
          control that quietly ticked all 173 buyers behind a list showing 24
          would be a trap in front of a button that messages people. */}
      {sorted.length > 0 && (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={() => {
              const shown = sorted.map((r) => r.id);
              const allOn = shown.every((id) => selected.has(id));
              setSelected((prev) => {
                const next = new Set(prev);
                for (const id of shown) { if (allOn) next.delete(id); else next.add(id); }
                return next;
              });
            }}
            className="font-body uppercase"
            style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", padding: "6px 10px" }}
          >
            {sorted.every((r) => selected.has(r.id)) ? `Clear these ${sorted.length}` : `Select all ${sorted.length}`}
          </button>
          {selected.size > 0 && (
            <button type="button" onClick={() => setSelected(new Set())} className="font-body uppercase"
              style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.mutedGreige, background: "transparent", border: "none", padding: "6px 2px" }}>
              Clear selection ({selected.size})
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
              <th style={{ width: 30, padding: "8px 0 8px 6px" }}><span className="sr-only">Select</span></th>
              <SortTh label="Business" k="business" sort={sort} onToggle={toggleSort} />
              <SortTh label="Owner" k="owner" sort={sort} onToggle={toggleSort} />
              <SortTh label="Phone" k="phone" sort={sort} onToggle={toggleSort} />
              <SortTh label="City" k="city" sort={sort} onToggle={toggleSort} />
              <SortTh label="Status" k="status" sort={sort} onToggle={toggleSort} />
              <SortTh label="Source" k="source" sort={sort} onToggle={toggleSort} />
              <SortTh label="Orders" k="orders" sort={sort} onToggle={toggleSort} defaultDir="desc" />
              <SortTh label="Last order" k="lastOrder" sort={sort} onToggle={toggleSort} defaultDir="desc" />
              <SortTh label="Created" k="created" sort={sort} onToggle={toggleSort} defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const wa = waLink(r.phone);
              return (
                <tr key={r.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)", background: selected.has(r.id) ? "rgba(201,169,110,0.10)" : undefined }}>
                  <td style={{ padding: "10px 0 10px 6px" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      aria-label={`Select ${r.business_name ?? "buyer"}`}
                      style={{ accentColor: palette.goldDeep }}
                    />
                  </td>
                  <td style={{ padding: "10px" }}>
                    <Link href={`/admin/buyers/${r.id}`} className="font-display" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{r.business_name ?? "—"}</Link>
                  </td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.owner_name ?? "—"}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.phone ?? "—"}
                      {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle size={13} strokeWidth={1.7} color={palette.goldDeep} /></a>}
                    </span>
                  </td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.city ?? "—"}</td>
                  <td style={{ padding: "10px" }}>
                    <StatusPill status={r.status} />
                    {r.pendingIdentity && (
                      <span
                        className="font-body uppercase"
                        style={{ marginLeft: 6, fontSize: 8.5, letterSpacing: "0.14em", color: palette.goldDeep }}
                        title="Business name or GSTIN change waiting on a decision"
                      >
                        Identity
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "10px" }}><SourcePill source={r.source} /></td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{r.ordersCount}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.softBlack, padding: "10px" }}>{fmtDate(r.lastOrder)}</td>
                  <td className="font-body" style={{ fontSize: 12, color: palette.mutedGreige, padding: "10px" }}>{fmtDate(r.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 font-body" style={{ fontSize: 12, color: palette.mutedGreige, letterSpacing: "0.08em" }}>No buyers match.</div>
        )}
      </div>

      {/* Batch bar — mirrors the studio board's, so the gesture is the same
          wherever staff are selecting rows. */}
      {selected.size > 0 && (
        <div className="fixed bottom-16 md:bottom-4 inset-x-0 z-40 mx-auto max-w-2xl px-3">
          <div className="flex items-center gap-2 flex-wrap p-3" style={{ background: palette.black, boxShadow: "0 6px 24px rgba(0,0,0,0.35)" }}>
            <span className="font-body" style={{ fontSize: 11, color: palette.champagne }}>
              {selected.size} selected
              {sendable.length !== selected.size && (
                <span style={{ color: palette.mutedGreige }}> · {sendable.length} can be messaged</span>
              )}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={pending || sendable.length === 0}
              onClick={sendCredentials}
              className="flex items-center gap-1.5 font-body uppercase disabled:opacity-40"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.black, background: palette.gold, padding: "8px 11px" }}
              title={sendable.length === 0 ? "None of these are active with a phone and a password on file" : undefined}
            >
              <MessageCircle size={12} strokeWidth={2} />
              {pending ? "Sending…" : `Send credentials (${sendable.length})`}
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="font-body uppercase"
              style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.champagne, border: `1px solid ${palette.champagne}`, padding: "8px 10px" }}>
              Clear
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-32 md:bottom-20 inset-x-0 z-50 flex justify-center px-3 pointer-events-none">
          <div className="font-body" style={{ background: palette.black, color: palette.ivory, fontSize: 11, padding: "9px 14px", letterSpacing: "0.04em" }}>{toast}</div>
        </div>
      )}
    </div>
  );
}
