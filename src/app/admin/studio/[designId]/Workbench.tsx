"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronDown, Check, X as XIcon, RefreshCw, SlidersHorizontal, Loader2 } from "lucide-react";
import { ZoomImage } from "@/components/Lightbox";
import { palette } from "@/lib/palette";
import type { BoardRow, AngleDetail, CopyDetail } from "@/lib/studio/load";
import { AI_ANGLES } from "@/lib/studio/state";
import { JobsTicker } from "../JobsTicker";
import { approveCandidate, rejectCandidate, approveAsIs, setAnglePrompt, setAngleEngine, regenAngle, generateCopy, saveCopyEdit, approveCopy, pushWholesale, pushShopify } from "./actions";

// Workbench client (§9). Card per angle: source vs current candidate (both
// zoomable — golden rule 2), engine chips (D4; seedream disabled; openai_bg
// behind ANSH-06), collapsed prompt box (hidden for raw; editing marks
// prompt_edited_by_human), Approve · Reject · Regen (credit estimate inline,
// D8), and the D1 "Previous attempts" history strip.

const FASHN_ESTIMATE = "~2 credits · 1k balanced";

interface Job { angleId: string | null; type: string; status: string; progress: number }

const drivePhoto = (id: string, s = 600) => `/api/drive-photo?id=${encodeURIComponent(id)}&s=${s}`;

export function Workbench({ board, angles, copy, activeJobs, openaiEnabled }: {
  board: BoardRow;
  angles: AngleDetail[];
  copy: CopyDetail | null;
  activeJobs: Job[];
  openaiEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [copyDraft, setCopyDraft] = useState({ title: copy?.title ?? "", description: copy?.description ?? "", tags: copy?.tags ?? {} });
  const copyDirty = !!copy && (copyDraft.title !== copy.title || copyDraft.description !== copy.description);
  // router.refresh() re-renders with fresh props but never re-runs useState
  // initializers — resync the editable draft whenever the server copy changes.
  useEffect(() => {
    setCopyDraft({ title: copy?.title ?? "", description: copy?.description ?? "", tags: copy?.tags ?? {} });
  }, [copy?.title, copy?.description, copy?.tags]);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }
  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      const r = await fn();
      flash(r.ok ? done : r.error ?? "Failed");
      if (r.ok) router.refresh();
    });
  }

  function jobFor(angleId: string): Job | undefined {
    return activeJobs.find((j) => j.angleId === angleId);
  }

  function statusBadge(a: AngleDetail): { label: string; bg: string; fg: string } {
    const job = jobFor(a.id);
    if (job) {
      return job.status === "running"
        ? { label: `Running ${job.progress}%`, bg: "#E4EAF1", fg: "#40608a" }
        : { label: "Queued", bg: "#EFE7DA", fg: "#7A6A4F" };
    }
    if (a.approvedImageId) return { label: "Approved", bg: "#DFF0E4", fg: "#1F6B45" };
    if (a.candidates.some((c) => c.status === "active")) return { label: "Needs review", bg: "#F6E7CB", fg: "#8a6d1a" };
    if (!a.sourceRef) return { label: "Needs source", bg: "#F7DFDC", fg: "#9C3A31" };
    return { label: "Ready to generate", bg: "#EFE7DA", fg: "#7A6A4F" };
  }

  function currentCandidate(a: AngleDetail) {
    return a.candidates.find((c) => c.id === a.approvedImageId) ?? a.candidates.find((c) => c.status === "active") ?? null;
  }

  const chipStyle = (active: boolean, disabled = false) => ({
    fontSize: 8.5, letterSpacing: "0.1em", padding: "5px 8px",
    background: active ? palette.black : "transparent",
    color: disabled ? "rgba(26,26,26,0.35)" : active ? palette.ivory : palette.softBlack,
    border: "1px solid rgba(26,26,26,0.2)",
  });

  const angleCard = (a: AngleDetail) => {
    const isDetail = a.angle.startsWith("detail");
    const badge = statusBadge(a);
    const current = currentCandidate(a);
    const history = a.candidates.filter((c) => c.id !== current?.id);
    const promptValue = prompts[a.id] ?? a.prompt;

    return (
      <div key={a.id} className="p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <div className="flex items-center justify-between">
          <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.18em", color: palette.black, fontWeight: 600 }}>
            {a.angle.replace("_", " ")}
          </span>
          <span className="font-body uppercase px-2 py-0.5" style={{ fontSize: 8, letterSpacing: "0.1em", fontWeight: 600, background: badge.bg, color: badge.fg }}>
            {badge.label}
          </span>
        </div>

        {/* Source vs current candidate — both zoomable */}
        <div className="grid grid-cols-2 gap-2 mt-2.5">
          <div>
            <div className="font-body uppercase mb-1" style={{ fontSize: 7.5, letterSpacing: "0.14em", color: palette.mutedGreige }}>Source</div>
            {a.sourceRef ? (
              <ZoomImage src={drivePhoto(a.sourceRef)} alt={`${a.angle} source`} width={150} height={188} />
            ) : (
              <div className="flex items-center justify-center font-body" style={{ height: 188, background: palette.ivoryDeep, fontSize: 10, color: palette.mutedGreige }}>no source</div>
            )}
          </div>
          <div>
            <div className="font-body uppercase mb-1" style={{ fontSize: 7.5, letterSpacing: "0.14em", color: palette.mutedGreige }}>
              {current && current.id === a.approvedImageId ? "Production" : "Candidate"}
            </div>
            {current ? (
              <ZoomImage src={drivePhoto(current.fileRef)} alt={`${a.angle} candidate`} width={150} height={188} />
            ) : (
              <div className="flex items-center justify-center font-body" style={{ height: 188, background: palette.ivoryDeep, fontSize: 10, color: palette.mutedGreige }}>none yet</div>
            )}
          </div>
        </div>

        {/* Engine chips (AI angles only — D5 keeps details raw) */}
        {!isDetail && (
          <div className="flex gap-1 mt-2.5">
            {(["fashn", "openai_bg", "raw"] as const).map((e) => (
              <button
                key={e}
                type="button"
                disabled={pending || (e === "openai_bg" && !openaiEnabled)}
                title={e === "openai_bg" && !openaiEnabled ? "Background engine — parked (ANSH-06)" : undefined}
                onClick={() => run(() => setAngleEngine(a.id, e), `Engine → ${e}`)}
                className="font-body uppercase"
                style={chipStyle(a.engine === e, e === "openai_bg" && !openaiEnabled)}
              >
                {e === "openai_bg" ? "BG swap" : e}
              </button>
            ))}
            <button type="button" disabled title="Coming later (ANSH-10)" className="font-body uppercase" style={chipStyle(false, true)}>
              seedream
            </button>
          </div>
        )}
        {isDetail && (
          <div className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
            Macro fidelity — embroidery is never AI-generated. Raw only.
          </div>
        )}

        {/* Prompt (hidden for raw) */}
        {!isDetail && a.engine !== "raw" && (
          <div className="mt-2">
            <button type="button" onClick={() => setPromptOpen((s) => ({ ...s, [a.id]: !s[a.id] }))} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>
              <ChevronDown size={11} style={{ transform: promptOpen[a.id] ? "rotate(180deg)" : "none" }} />
              Prompt{a.promptEditedByHuman ? " · edited" : ""}
            </button>
            {promptOpen[a.id] && (
              <div className="mt-1.5">
                <textarea
                  value={promptValue}
                  onChange={(e) => setPrompts((s) => ({ ...s, [a.id]: e.target.value }))}
                  rows={3}
                  className="w-full font-mono p-2"
                  style={{ fontSize: 10.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black }}
                />
                <button
                  type="button"
                  disabled={pending || promptValue === a.prompt}
                  onClick={() => run(() => setAnglePrompt(a.id, promptValue), "Prompt saved")}
                  className="mt-1 font-body uppercase disabled:opacity-40"
                  style={{ fontSize: 8.5, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, padding: "5px 9px" }}
                >
                  Save prompt
                </button>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {current && current.status === "generated" && (
            <button type="button" disabled={pending} onClick={() => run(() => approveCandidate(current.id), "Approved")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: "#1F6B45", color: "#fff", padding: "7px 10px" }}>
              <Check size={11} /> Approve
            </button>
          )}
          {current && (
            <button type="button" disabled={pending} onClick={() => run(() => rejectCandidate(current.id), "Rejected")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: "1px solid #9C3A31", color: "#9C3A31", padding: "7px 10px" }}>
              <XIcon size={11} /> Reject
            </button>
          )}
          {(isDetail || a.engine === "raw") && a.sourceRef && !a.approvedImageId && (
            <button type="button" disabled={pending} onClick={() => run(() => approveAsIs(a.id), "Approved as-is")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "7px 10px" }}>
              <Check size={11} /> Approve as-is
            </button>
          )}
          {!isDetail && a.engine !== "raw" && a.sourceRef && !jobFor(a.id) && (
            <button type="button" disabled={pending} onClick={() => run(() => regenAngle(a.id), "Job queued")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }} title={FASHN_ESTIMATE}>
              <RefreshCw size={11} /> {current ? "Regen" : "Generate"} · {FASHN_ESTIMATE}
            </button>
          )}
          {jobFor(a.id) && <span className="flex items-center gap-1 font-body" style={{ fontSize: 9.5, color: palette.goldDeep }}><Loader2 size={11} className="animate-spin" /> job in flight</span>}
        </div>

        {/* D1 history */}
        {history.length > 0 && (
          <div className="mt-2.5">
            <button type="button" onClick={() => setHistoryOpen((s) => ({ ...s, [a.id]: !s[a.id] }))} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>
              Previous attempts ({history.length})
            </button>
            {historyOpen[a.id] && (
              <div className="flex gap-2 mt-1.5 overflow-x-auto">
                {history.map((c) => (
                  <div key={c.id} className="flex-shrink-0" style={{ width: 84 }}>
                    <ZoomImage src={drivePhoto(c.fileRef, 300)} alt="attempt" width={84} height={105} />
                    <div className="font-mono" style={{ fontSize: 7.5, color: palette.mutedGreige }}>{c.engine} · {c.status}</div>
                    {c.id !== a.approvedImageId && (
                      <button type="button" disabled={pending} onClick={() => run(() => approveCandidate(c.id), "Approved from history")} className="font-body uppercase mt-0.5" style={{ fontSize: 7.5, letterSpacing: "0.08em", color: "#1F6B45" }}>
                        Approve this
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl">
      <Link href="/admin/studio" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Studio
      </Link>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-mono" style={{ fontSize: 19, fontWeight: 700, color: palette.black }}>{board.baseSku} · {board.color}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{board.title ?? "—"}</div>
          <div className="font-body uppercase inline-block mt-2 px-2 py-1" style={{ fontSize: 9, letterSpacing: "0.12em", fontWeight: 600, background: palette.ivoryDeep, color: palette.softBlack }}>
            {board.badgeLabel}
          </div>
        </div>
        <Link href={`/admin/studio/master/${board.id}`} aria-label="Product master" title="Product Master editor">
          <SlidersHorizontal size={16} color={palette.mutedGreige} />
        </Link>
      </div>

      {/* Destination strip — same gate functions Stage 7 pushes call */}
      <div className="grid grid-cols-2 gap-2 mt-4">
        {(["wholesale", "shopify"] as const).map((portal) => {
          const g = board.gates[portal];
          const t = board.targets.find((x) => x.portal === portal);
          return (
            <details key={portal} className="p-3" style={{ background: palette.ivory, border: `1px solid ${g.ready ? "#1F6B45" : "rgba(26,26,26,0.1)"}` }}>
              <summary className="flex items-center justify-between cursor-pointer list-none">
                <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: palette.black, fontWeight: 600 }}>
                  {portal === "wholesale" ? "Wholesale" : "Shopify"}
                </span>
                <span className="font-body" style={{ fontSize: 9, color: t?.enabled === false ? palette.mutedGreige : g.ready ? "#1F6B45" : "#8a6d1a" }}>
                  {t?.enabled === false ? "disabled" : t?.state === "live" ? "live" : t?.state === "changes_pending" ? "changes pending" : g.ready ? "ready" : `${g.blockers.length} blocker${g.blockers.length === 1 ? "" : "s"}`}
                </span>
              </summary>
              {!g.ready && t?.enabled !== false && (
                <ul className="mt-1.5">
                  {g.blockers.map((b) => <li key={b} className="font-body" style={{ fontSize: 10, color: palette.mutedGreige, lineHeight: 1.7 }}>· {b}</li>)}
                </ul>
              )}
              <button
                type="button"
                disabled={pending || (!g.ready && t?.state !== "changes_pending") || t?.enabled === false}
                onClick={() =>
                  run(
                    () => (portal === "wholesale" ? pushWholesale(board.id) : pushShopify(board.id)),
                    t?.state === "changes_pending" ? "Re-pushed" : "Pushed",
                  )
                }
                className="mt-2 w-full font-body uppercase disabled:opacity-40"
                style={{ fontSize: 8.5, letterSpacing: "0.12em", background: g.ready || t?.state === "changes_pending" ? palette.black : "transparent", color: g.ready || t?.state === "changes_pending" ? palette.ivory : palette.black, border: `1px solid ${palette.black}`, padding: "7px 0" }}
                title={portal === "shopify" ? "Creates a DRAFT product — parked until ANSH-05 flips SHOPIFY_ENABLED" : undefined}
              >
                {t?.state === "changes_pending" ? "Re-push" : "Push"} {portal === "wholesale" ? "wholesale" : "Shopify"}
              </button>
            </details>
          );
        })}
      </div>

      <JobsTicker />

      <div className="mt-4 flex flex-col gap-2 pb-10">
        {angles.filter((a) => (AI_ANGLES as readonly string[]).includes(a.angle)).map(angleCard)}
        <div className="font-body uppercase mt-2" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Detail · macro</div>
        {angles.filter((a) => !(AI_ANGLES as readonly string[]).includes(a.angle)).map(angleCard)}

        {/* Copy panel (§10) */}
        <div className="mt-2 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="flex items-center justify-between">
            <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Copy</span>
            <span className="font-body uppercase px-2 py-0.5" style={{ fontSize: 8, letterSpacing: "0.1em", fontWeight: 600, background: copy?.status === "approved" ? "#DFF0E4" : copy ? "#F6E7CB" : palette.ivoryDeep, color: copy?.status === "approved" ? "#1F6B45" : copy ? "#8a6d1a" : palette.mutedGreige }}>
              {copy?.status ?? "none"}
            </span>
          </div>

          {!board.specsVerified && (
            <div className="font-body mt-2" style={{ fontSize: 10.5, color: "#8a6d1a" }}>
              Awaiting Rakesh&apos;s specs — copy generation is locked until specs are verified (STRICT_SPEC_MODE).
            </div>
          )}

          {copy ? (
            <div className="mt-2">
              <input
                value={copyDraft.title}
                onChange={(e) => setCopyDraft((s) => ({ ...s, title: e.target.value.slice(0, 60) }))}
                className="w-full font-display p-2"
                style={{ fontSize: 14, fontWeight: 600, border: "1px solid rgba(26,26,26,0.12)", background: "#fff", color: palette.black }}
              />
              <textarea
                value={copyDraft.description}
                onChange={(e) => setCopyDraft((s) => ({ ...s, description: e.target.value }))}
                rows={3}
                className="w-full font-body p-2 mt-1.5"
                style={{ fontSize: 12, lineHeight: 1.6, border: "1px solid rgba(26,26,26,0.12)", background: "#fff", color: palette.softBlack }}
              />
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {Object.entries(copyDraft.tags).map(([k, v]) => (
                  <span key={k} className="font-body px-2 py-1" style={{ fontSize: 9.5, background: palette.ivoryDeep, color: palette.softBlack }}>
                    <b>{k}</b> · {v}
                  </span>
                ))}
              </div>
              <div className="font-body mt-1.5" style={{ fontSize: 8.5, color: palette.mutedGreige }}>
                {copy.model ?? "—"}{copy.editedBy ? ` · edited by ${copy.editedBy}` : ""}{copy.approvedBy ? ` · approved by ${copy.approvedBy}` : ""}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {copyDirty && (
                  <button type="button" disabled={pending} onClick={() => run(() => saveCopyEdit(board.id, copyDraft), "Copy saved as draft")} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "7px 10px" }}>
                    Save edit
                  </button>
                )}
                {copy.status === "draft" && !copyDirty && (
                  <button type="button" disabled={pending} onClick={() => run(() => approveCopy(board.id), "Copy approved")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: "#1F6B45", color: "#fff", padding: "7px 10px" }}>
                    <Check size={11} /> Approve copy
                  </button>
                )}
                <button type="button" disabled={pending || !board.specsVerified} onClick={() => run(() => generateCopy(board.id), "Copy regenerated")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }} title="One vision call — a few paise">
                  <RefreshCw size={11} /> Regen · vision call
                </button>
              </div>
            </div>
          ) : (
            <button type="button" disabled={pending || !board.specsVerified} onClick={() => run(() => generateCopy(board.id), "Copy generated")} className="mt-2 flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "8px 11px" }} title="One vision call — a few paise">
              Generate copy · vision call
            </button>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
