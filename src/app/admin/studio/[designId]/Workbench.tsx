"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, X as XIcon, RefreshCw, SlidersHorizontal, Loader2, Camera, Upload, Crop as CropIcon, Columns2, Image as ImageIcon } from "lucide-react";
import { ZoomImage } from "@/components/Lightbox";
import { BackLink, withFrom, useHere } from "@/components/BackLink";
import { DraftNotice } from "@/components/DraftNotice";
import { palette } from "@/lib/palette";
import { tooLargeMessage } from "@/lib/downscale-photo";
import { useDraft } from "@/lib/useDraft";
import { COPY_MODELS, estimateLabel } from "@/lib/studio/copy-models";
import type { BoardRow, AngleDetail, CopyDetail, DesignImage } from "@/lib/studio/load";
import { AI_ANGLES } from "@/lib/studio/state";
import { JobsTicker } from "../JobsTicker";
// setBrandModel is deliberately absent: the picker it drove is not rendered
// while fashn is parked (see the angle card). The action itself still exists.
import { setBgStyle, setCopyPrompt as setCopyPromptAction, setCopyModel, setAnglePrompt, setAngleEngine, regenAngle, cancelAngleJob, generateCopy, saveCopyEdit, pushWholesale, pushShopify } from "./actions";
import { unpublishDesign, setDiscontinued } from "../actions";
import { BG_COLOURS, BG_MODE_DEFAULT, BG_MODE_LABEL, BG_MODE_SWATCH, resolveBackground, type BgMode, type BgSwatch } from "@/lib/studio/backgrounds";
import { useToast } from "@/lib/use-toast";
import { uploadSource, importFinished, applyImageDirectly, approveImage, rejectImage, saveCrop, setAngleSource, syncDrivePhotos } from "./image-actions";
import { ImagePicker, CropSheet, CompareSheet, drivePhotoDownload } from "./ImageTools";

// Workbench client (§9). Card per angle: source vs current candidate (both
// zoomable — golden rule 2), engine chips (D4; seedream disabled; openai_bg
// behind ANSH-06), collapsed prompt box (hidden for raw; editing marks
// prompt_edited_by_human), Use this · Reject · Regen (credit estimate inline,
// D8), and the D1 "Previous attempts" history strip.
//
// 17 Sep — the approval STEP is retired: a slot counts once it holds an
// effective image and copy counts as a real draft; the manual push is the
// human control. What remains of "Approve" is choosing which generated
// candidate ships instead of the source — kept, but labelled "Use this"
// because that is all it does now. approveImage/approveCopy stay exported
// from the action modules for back-compat.

const ENGINE_LABEL: Record<string, string> = { fashn: "fashn", seedream: "seedream", nano_banana: "nano banana", matte: "matte", openai_bg: "OpenAI", raw: "raw" };
const ENGINE_HINT: Record<string, string> = {
  fashn: "Model-swap onto the brand model — parked (FASHN_ENABLED)",
  seedream: "Seedream v5 Pro edit via fal.ai — background change at the source's own size. Its content checker refuses some catalogue photos; when it does, the job says so and Nano Banana is the fix.",
  nano_banana: "Nano Banana 2 edit via fal.ai — background change at 2K, so the published s1200 is never upscaled. Renders the photos Seedream's checker refuses.",
  // The one thing an operator cannot see from four chips is what this engine
  // does NOT do, so the hint leads with it. Matte keeps the photograph's own
  // pixels, which is also why it can never correct them.
  matte: "Cuts the garment out and composites it onto the background locally — the photo's own pixels, so nothing is re-drawn and no colour can drift. NO COLOUR CORRECTION: a flat or colour-cast source stays flat, and that is the reason to pick a generative chip instead. Sheer hems can come back with small holes. ~50x cheaper and a few seconds.",
  openai_bg: "OpenAI image edit — background normalisation",
  raw: "No generation — the source publishes as-is",
};

// 19 Sep — fashn and raw are no longer offered. fashn is parked behind a flag
// (its code is intact, nothing routes to it); raw was only ever a "do not
// offer Generate" marker, and publishing has always used the approved
// candidate ?? the source, so dropping the chip changes nothing that ships.
// 20 Sep — nano banana joins the two edit engines (Ansh, after a 38-render
// bench). seedream stays the default; this adds a chip, it does not re-point
// any angle already set.
// 20 Sep, later — matte joins as a fourth chip of a different KIND: it never
// asks a model for a new photograph, it composites the existing one. It sits
// last because it is the fallback when a generative render invented something,
// not the default anyone should reach for first.
const ENGINE_CHIPS = ["seedream", "nano_banana", "openai_bg", "matte"] as const;

/** What each background mode actually does, in the operator's terms. */
const BG_CAPTION: Record<BgMode, string> = {
  minimal: "White background, colour-corrected — the recommended look, and the one the bench preferred.",
  grey: "The original seamless grey studio treatment, described to the model in words.",
  coloured: "The chosen backdrop is sent to the model as a reference image, not described in words.",
};
// Per OUTPUT IMAGE, from fal's and OpenAI's own listings (20 Sep). These are
// the real prices at the settings we actually send, not the headline rate.
//
// seedream is a RANGE, not a number: v5 Pro bills $0.0675 at or below 1536²
// and $0.135 above it, and we ask for the source's own pixel dimensions — a
// storage-hosted capture (fetchImageByRef does not bound those) or a squarish
// macro crop lands in the upper band. Quoting only $0.07 would understate a
// real render by 2×, which is worse than a wider estimate. Nano banana is
// $0.08 × 1.5 because we render at 2K rather than the 1K default — change
// DREVI_NANO_RESOLUTION and this figure stops being true. Mirrors ENGINE_COST
// in engines.ts — move both together.
// matte's figure is the only MEASURED one here (fal balance before/after on
// three real renders, $0.00222 each) and the only one with no upper band: one
// segmentation call is the whole spend, the compositing is local.
const ENGINE_ESTIMATE: Record<string, string> = { fashn: "~2 credits", seedream: "~$0.07–$0.14", nano_banana: "~$0.12", matte: "~$0.0022", openai_bg: "~$0.22" };

interface Job { angleId: string | null; type: string; status: string; progress: number }

const drivePhoto = (id: string, s = 600) => `/api/drive-photo?id=${encodeURIComponent(id)}&s=${s}`;
// Downloads (20 Sep) ride the zoom every photo on this page already opens —
// see Lightbox. The card keeps its 8pt button row; the overlay, which was
// empty, gains one icon. drivePhotoDownload lives in ImageTools next to its
// thumbnail sibling so the picker and the compare sheet share one URL rule.

// brandModels / brandModel stay in the prop TYPE and are still passed by
// page.tsx, but are not destructured: the only UI that read them was the
// fashn brand-model picker, parked on 19 Sep, and an unused binding is a lint
// error here. Restoring the picker means adding both names back to this list.
export function Workbench({ board, angles, copy, pool, activeJobs, enginesEnabled, bgStyle, bgSeed, driveFolderId, uploadsOk, uploadsMessage }: {
  board: BoardRow;
  angles: AngleDetail[];
  copy: CopyDetail;
  pool: DesignImage[];
  activeJobs: Job[];
  enginesEnabled: { fashn: boolean; seedream: boolean; nano_banana: boolean; matte: boolean; openai_bg: boolean };
  brandModels: string[];
  brandModel: string;
  bgStyle: string;
  bgSeed: string;
  driveFolderId: string | null;
  uploadsOk: boolean;
  uploadsMessage: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, flash] = useToast();
  const [promptOpen, setPromptOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  // Per-angle prompt edits keyed by angle id. An entry equal to its server
  // prompt is pruned — on restore and after every refresh — so a saved
  // prompt drops its key once the refresh confirms it (dropping it on click
  // would flash the old prompt in the box until the refresh lands).
  const isPromptEdit = (angleId: string, p: string) => { const sp = angles.find((a) => a.id === angleId)?.prompt; return sp !== undefined && p !== sp; };
  const prunePrompts = (s: Record<string, string>) => {
    const kept = Object.entries(s).filter(([id, p]) => isPromptEdit(id, p));
    return kept.length === Object.keys(s).length ? s : Object.fromEntries(kept);
  };
  const [prompts, setPrompts, promptsMeta] = useDraft<Record<string, string>>(`drevi:draft:angle-prompts:${board.id}`, {}, {
    hasContent: (s) => Object.entries(s).some(([id, p]) => isPromptEdit(id, p)),
    onRestore: prunePrompts,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPrompts(prunePrompts); }, [angles]);
  // R5 sheets
  const [picker, setPicker] = useState<{ angleId: string; intent: "use" | "source" } | null>(null);
  const [crop, setCrop] = useState<{ angleId: string | null; parentId: string; fileRef: string } | null>(null);
  const [compare, setCompare] = useState<{ left: string; right: string; leftLabel: string; rightLabel: string } | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  // Queue the job, then run it in-process (UX sprint — no hosted runner).
  // The card shows "job in flight" from the refreshed activeJobs; a second
  // refresh lands the candidate or the error.
  function generate(angleId: string) {
    startTransition(async () => {
      const r = await regenAngle(angleId);
      if (!r.ok || !r.jobId) { flash(r.error ?? "Could not queue the job"); return; }
      flash("Generating…");
      router.refresh();
      try {
        const res = await fetch("/api/pipeline/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: r.jobId }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.pending) {
          // FASHN split flow (2 Aug): short polls until the render lands —
          // each server call stays well under Vercel's function ceiling.
          flash("FASHN rendering — usually 2–4 minutes…");
          const deadline = Date.now() + 6 * 60_000;
          for (;;) {
            if (Date.now() > deadline) { flash("Still rendering — check the job strip later"); break; }
            await new Promise((ok) => setTimeout(ok, 4000));
            const p = await fetch("/api/pipeline/poll", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jobId: r.jobId }),
            });
            const pb = await p.json().catch(() => ({}));
            if (pb.done) { flash("Candidate ready — review below"); break; }
            if (!p.ok) { flash(pb.error ?? "Generation failed"); break; }
          }
        } else {
          flash(res.ok ? "Candidate ready — review below" : body.error ?? "Generation failed");
        }
      } catch {
        flash("Generation failed — check the job strip");
      }
      router.refresh();
    });
  }
  const [copyPromptOpen, setCopyPromptOpen] = useState(false);
  const [copyPrompt, setCopyPrompt, copyPromptMeta] = useDraft(`drevi:draft:copy-prompt:${board.id}`, copy.prompt, {
    base: copy.prompt,
    hasContent: (p) => p !== copy.prompt,
  });

  function uploadFor(angleId: string, kind: "source" | "import", file: File) {
    if (!uploadsOk) { flash(uploadsMessage); return; }
    // Deliberately NOT downscaled: these are the production images that get
    // published to wholesale and Shopify, so resizing them here would quietly
    // degrade the catalogue. Instead say why an oversized file cannot be sent.
    const tooBig = tooLargeMessage(file);
    if (tooBig) { flash(tooBig); return; }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("photo", file);
      const r = kind === "source" ? await uploadSource(angleId, fd) : await importFinished(angleId, fd);
      flash(r.ok ? (kind === "source" ? "Source added" : "Image imported") : r.error ?? "Upload failed");
      if (r.ok) router.refresh();
    });
  }
  const serverCopy = { title: copy.title, description: copy.description };
  const [copyDraft, setCopyDraft, copyMeta] = useDraft(`drevi:draft:copy:${board.id}`, serverCopy, {
    base: JSON.stringify(serverCopy),
    hasContent: (d) => d.title !== copy.title || d.description !== copy.description,
  });
  const copyDirty = copyDraft.title !== copy.title || copyDraft.description !== copy.description;
  // router.refresh() re-renders with fresh props but never re-runs useState
  // initializers. Only a REAL change of the server copy may touch the draft
  // (keying on the `copy` object clobbered edits on every refresh): a clean
  // draft adopts it, a dirty one is kept behind the stale notice.
  const [copyServerMoved, setCopyServerMoved] = useState(false);
  const serverCopyRef = useRef(serverCopy);
  const adoptNextCopyRef = useRef(false);
  const adoptServerCopy = () => { setCopyDraft({ title: copy.title, description: copy.description }); copyMeta.clear(); setCopyServerMoved(false); };
  const copyRegenerated = () => { adoptNextCopyRef.current = true; copyMeta.clear(); }; // generated copy replaces any edit
  useEffect(() => {
    const prev = serverCopyRef.current;
    if (prev.title === copy.title && prev.description === copy.description) return;
    serverCopyRef.current = { title: copy.title, description: copy.description };
    const editedSincePrev = copyDraft.title !== prev.title || copyDraft.description !== prev.description;
    if (adoptNextCopyRef.current || !editedSincePrev || !copyDirty) { adoptNextCopyRef.current = false; adoptServerCopy(); }
    else setCopyServerMoved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy.title, copy.description]);

  const serverPromptRef = useRef(copy.prompt);
  const adoptNextPromptRef = useRef(false);
  useEffect(() => {
    const prev = serverPromptRef.current;
    if (prev === copy.prompt) return;
    serverPromptRef.current = copy.prompt;
    if (adoptNextPromptRef.current || copyPrompt === prev || copyPrompt === copy.prompt) {
      adoptNextPromptRef.current = false;
      setCopyPrompt(copy.prompt);
      copyPromptMeta.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy.prompt]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string, onOk?: () => void) {
    startTransition(async () => {
      const r = await fn();
      flash(r.ok ? done : r.error ?? "Failed");
      if (r.ok) { onOk?.(); router.refresh(); }
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

  // The design's background, with 'auto' already resolved — drives which mode
  // button reads as active and whether the plate row is shown at all.
  const bg = resolveBackground(bgStyle, bgSeed);

  // Wall over floor with a hard stop, not a blur: the dot reads as a backdrop
  // with a horizon rather than a paint chip. The ring is what keeps the white
  // one visible, and it flips light on a lit chip so it survives both grounds.
  const swatchDot = (sw: BgSwatch, active: boolean) => (
    <span
      aria-hidden
      style={{
        width: 11, height: 11, borderRadius: "50%", flexShrink: 0, display: "inline-block",
        background: `linear-gradient(to bottom, ${sw.wall} 62%, ${sw.floor} 62%)`,
        border: `1px solid ${active ? "rgba(250,246,240,0.65)" : "rgba(26,26,26,0.25)"}`,
      }}
    />
  );

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
              <ZoomImage src={drivePhoto(a.sourceRef)} downloadHref={drivePhotoDownload(a.sourceRef)} alt={`${a.angle} source`} width={150} height={188} />
            ) : (
              <div className="flex items-center justify-center font-body" style={{ height: 188, background: palette.ivoryDeep, fontSize: 10, color: palette.mutedGreige }}>no source</div>
            )}
          </div>
          <div>
            <div className="font-body uppercase mb-1" style={{ fontSize: 7.5, letterSpacing: "0.14em", color: palette.mutedGreige }}>
              {current && current.id === a.approvedImageId ? "Production" : "Candidate"}
            </div>
            {current ? (
              <ZoomImage src={drivePhoto(current.fileRef)} downloadHref={drivePhotoDownload(current.fileRef)} alt={`${a.angle} ${current.id === a.approvedImageId ? "production" : "candidate"}`} width={150} height={188} />
            ) : (
              <div className="flex items-center justify-center font-body" style={{ height: 188, background: palette.ivoryDeep, fontSize: 10, color: palette.mutedGreige }}>none yet</div>
            )}
          </div>
        </div>

        {/* Engine chips. Both angle kinds get the SAME edit engines (Ansh,
            19 Sep) — the detail/model split existed only because model swap
            was in the model-angle list, and model swap is parked. */}
        {(
          <div className="flex gap-1 mt-2.5 flex-wrap">
            {/* An angle still stored on a retired engine gets a chip of its
                own, greyed and unclickable. Without it nothing on the card was
                lit and the operator could not tell what the angle was set to —
                which is 1,666 of prod's 1,674 angles until 0053 is applied,
                and any angle at all if the code ships ahead of the migration.
                Naming it is what makes "pick seedream" the obvious next move. */}
            {!ENGINE_CHIPS.includes(a.engine as (typeof ENGINE_CHIPS)[number]) && (
              <button
                type="button"
                disabled
                title={`${ENGINE_LABEL[a.engine] ?? a.engine} is retired — pick seedream, nano banana, OpenAI or matte to generate this angle`}
                className="font-body uppercase"
                style={{ ...chipStyle(true, true), textDecoration: "line-through" }}
              >
                {ENGINE_LABEL[a.engine] ?? a.engine}
              </button>
            )}
            {ENGINE_CHIPS.map((e) => {
              const off = !enginesEnabled[e];
              return (
                <button
                  key={e}
                  type="button"
                  disabled={pending || off}
                  title={off ? `${ENGINE_LABEL[e]} — API key not configured` : ENGINE_HINT[e]}
                  onClick={() => run(() => setAngleEngine(a.id, e), `Engine → ${ENGINE_LABEL[e]}`)}
                  className="font-body uppercase"
                  style={chipStyle(a.engine === e, off)}
                >
                  {ENGINE_LABEL[e]}
                </button>
              );
            })}
          </div>
        )}
        {/* The brand-model picker only ever applied to fashn's model swap, so
            with fashn parked (19 Sep) it is dead UI and is not rendered. The
            props, the action (setBrandModel, still exported from ./actions)
            and designs.brand_model all stay — re-enabling FASHN_ENABLED should
            be a small change here, not an archaeology exercise. Restore by
            re-importing setBrandModel and gating a <select> of {brandModels}
            (value={brandModel}) on:
              !isDetail && a.engine === "fashn" && brandModels.length > 0 */}
        {isDetail && (
          <div className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
            Macro fidelity — the edit engines only replace the background; embroidery is never re-generated.
          </div>
        )}

        {/* Prompt (hidden for raw — and for matte, which sends no prompt
            anywhere: it composites the source pixels onto a ground drawn
            locally, so a box the operator could type into would be a lie
            about what the chip does. defaultAnglePrompt returns '' for it). */}
        {a.engine !== "raw" && a.engine !== "matte" && (
          <div className="mt-2">
            <button type="button" onClick={() => setPromptOpen((s) => ({ ...s, [a.id]: !s[a.id] }))} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>
              <ChevronDown size={11} style={{ transform: promptOpen[a.id] ? "rotate(180deg)" : "none" }} />
              Prompt{a.promptEditedByHuman ? " · edited" : ""}{promptValue !== a.prompt ? " · unsaved" : ""}
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

        {/* Four input modes (§7.1) — A shoot · B use directly · C import · D generate */}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          ref={(el) => { fileInputs.current[`${a.id}:source`] = el; }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFor(a.id, "source", f); e.currentTarget.value = ""; }}
        />
        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={(el) => { fileInputs.current[`${a.id}:source-gallery`] = el; }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFor(a.id, "source", f); e.currentTarget.value = ""; }}
        />
        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={(el) => { fileInputs.current[`${a.id}:import`] = el; }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFor(a.id, "import", f); e.currentTarget.value = ""; }}
        />
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <button type="button" disabled={pending || !uploadsOk} title={uploadsOk ? "Shoot or upload a new source" : uploadsMessage} onClick={() => fileInputs.current[`${a.id}:source`]?.click()} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
            <Camera size={11} /> Shoot
          </button>
          <button type="button" disabled={pending || !uploadsOk} title={uploadsOk ? "Pick a new source photo from the gallery" : uploadsMessage} onClick={() => fileInputs.current[`${a.id}:source-gallery`]?.click()} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
            <ImageIcon size={11} /> Gallery
          </button>
          <button type="button" disabled={pending} onClick={() => setPicker({ angleId: a.id, intent: "use" })} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }} title="Use an existing image as-is — no generation, no cost">
            <ImageIcon size={11} /> Use directly
          </button>
          <button type="button" disabled={pending || !uploadsOk} title={uploadsOk ? "Import a finished image (Canva, Photoshop, phone edit)" : uploadsMessage} onClick={() => fileInputs.current[`${a.id}:import`]?.click()} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
            <Upload size={11} /> Import
          </button>
          <button type="button" disabled={pending} onClick={() => setPicker({ angleId: a.id, intent: "source" })} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }} title="Pick an existing image of this design as the source">
            <ImageIcon size={11} /> {a.sourceRef ? "Change source" : "Pick source"}
          </button>
          {current && a.sourceRef && current.id !== a.sourceImageId && (
            <button type="button" onClick={() => setCompare({ left: a.sourceRef!, right: current.fileRef, leftLabel: "Source", rightLabel: current.id === a.approvedImageId ? "Production" : "Candidate" })} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
              <Columns2 size={11} /> Compare
            </button>
          )}
          {(current || a.sourceRef) && uploadsOk && (
            <button type="button" onClick={() => setCrop({ angleId: a.id, parentId: current?.id ?? a.sourceImageId ?? "", fileRef: current?.fileRef ?? a.sourceRef! })} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }}>
              <CropIcon size={11} /> Crop / Rotate
            </button>
          )}
        </div>

        {/* Review actions */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {current && current.id !== a.approvedImageId && (
            <button type="button" disabled={pending} onClick={() => run(() => approveImage(a.id, current.id), "Set as production")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: "#1F6B45", color: "#fff", padding: "7px 10px" }} title="Make this candidate the image that publishes — otherwise the source ships">
              <Check size={11} /> Use this
            </button>
          )}
          {current && (
            <button type="button" disabled={pending} onClick={() => run(() => rejectImage(current.id), "Rejected")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: "1px solid #9C3A31", color: "#9C3A31", padding: "7px 10px" }}>
              <XIcon size={11} /> Reject
            </button>
          )}
          {/* Approve-as-is retired (17 Sep): the source already counts as
              filled and publishes as the effective image, so the stamp was a
              no-op. approveAsIs stays exported for back-compat. */}
          {/* Offered engines only. The old gate was `engine !== "raw"`, which still
              rendered Generate for an angle on the parked fashn — a button whose
              only outcome was an error naming an environment variable. */}
          {ENGINE_CHIPS.includes(a.engine as (typeof ENGINE_CHIPS)[number]) && a.sourceRef && !jobFor(a.id) && (
            <button type="button" disabled={pending} onClick={() => generate(a.id)} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }} title={ENGINE_HINT[a.engine]}>
              <RefreshCw size={11} /> {current ? "Regen" : "Generate"} · {ENGINE_ESTIMATE[a.engine] ?? ""}
            </button>
          )}
          {jobFor(a.id) && (
            <>
              <span className="flex items-center gap-1 font-body" style={{ fontSize: 9.5, color: palette.goldDeep }}><Loader2 size={11} className="animate-spin" /> job in flight</span>
              {/* The manual kill — but ONLY when the candidate Reject above is
                  absent, so a card never shows two buttons both saying Reject.
                  With a candidate present that one already does this: since
                  20 Sep rejectImage cancels its angle's in-flight jobs too. So
                  there is always exactly one Reject, and it always frees the
                  angle. A job that is plainly dead should not cost the operator
                  a five-minute wait for the sweep, and while it sits here
                  Generate is hidden — without this the angle has no way out. */}
              {!current && <button type="button" disabled={pending} onClick={() => run(() => cancelAngleJob(a.id), "Job cancelled")} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: "1px solid #9C3A31", color: "#9C3A31", padding: "7px 10px" }} title="Stop this job and free the angle">
                <XIcon size={11} /> Reject
              </button>}
            </>
          )}
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
                    <ZoomImage src={drivePhoto(c.fileRef, 300)} downloadHref={drivePhotoDownload(c.fileRef)} alt={`${a.angle} previous attempt`} width={84} height={105} />
                    <div className="font-mono" style={{ fontSize: 7.5, color: palette.mutedGreige }}>{c.engine} · {c.status}</div>
                    {c.id !== a.approvedImageId && (
                      <button type="button" disabled={pending} onClick={() => run(() => approveImage(a.id, c.id), "Set as production")} className="font-body uppercase mt-0.5" style={{ fontSize: 7.5, letterSpacing: "0.08em", color: "#1F6B45" }}>
                        Use this
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

  const here = useHere(`/admin/studio/${board.id}`);
  const specsHref = withFrom(`/admin/studio/master/${board.id}`, here);

  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl">
      <BackLink fallback="/admin/studio" fallbackLabel="Studio" />

      <div className="mt-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-mono" style={{ fontSize: 19, fontWeight: 700, color: palette.black }}>{board.baseSku} · {board.color}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{board.title ?? "—"}</div>
          <div className="font-body uppercase inline-block mt-2 px-2 py-1" style={{ fontSize: 9, letterSpacing: "0.12em", fontWeight: 600, background: palette.ivoryDeep, color: palette.softBlack }}>
            {board.badgeLabel}
          </div>

          {/* Discontinued (0063). The banner carries who and when, because a
              stamp nobody can read is barely better than a boolean — and the
              restore lives right on it, where someone who has just found the
              product is standing. */}
          {board.discontinuedAt && (
            <div className="mt-2 p-2.5" style={{ border: "1px solid #9C3A31", background: "rgba(156,58,49,0.06)" }}>
              <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: "#9C3A31" }}>Discontinued</div>
              <div className="font-body mt-1" style={{ fontSize: 11, color: palette.softBlack, lineHeight: 1.6 }}>
                {new Date(board.discontinuedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}
                {board.discontinuedBy ? ` · ${board.discontinuedBy}` : ""}
                {board.discontinuedNote ? ` — ${board.discontinuedNote}` : ""}
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => setDiscontinued(board.id, false), "Restored")}
                className="mt-1.5 font-body uppercase disabled:opacity-40"
                style={{ fontSize: 9, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", padding: "6px 10px" }}
              >
                Restore this product
              </button>
              <div className="font-body mt-1.5" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
                Restoring brings it back to the board. It does not put it back in the buyer catalog — push wholesale for that.
              </div>
            </div>
          )}
        </div>
        <span className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(async () => {
              const r = await syncDrivePhotos(board.id);
              flash(r.ok ? (r.added ? `${r.added} photo(s) pulled from Drive` : "Drive folder already in sync") : r.error ?? "Sync failed");
              if (r.ok) router.refresh();
            })}
            className="font-body uppercase disabled:opacity-40"
            style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.goldDeep }}
            title="Register photos added straight to the design's Drive folder so they appear in the picker"
          >
            Sync Drive
          </button>
          {driveFolderId && (
            <a
              href={`https://drive.google.com/drive/folders/${driveFolderId}`}
              target="_blank"
              rel="noreferrer"
              className="font-body uppercase"
              style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige, textDecoration: "underline" }}
              title="The exact Drive folder this design's photos live in — every shoot, import and generation lands here"
            >
              Folder
            </a>
          )}
          {/* One page for everything about the product (12 Sep) — specs,
              supply, both prices, HSN, stock and the publish toggles. */}
          <Link href={specsHref} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.goldDeep }} title="Specs, supply, wholesale + retail price, HSN and stock">
            <SlidersHorizontal size={14} /> Product details
          </Link>
        </span>
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
                  {g.blockers.map((b) => (
                    <li key={b} className="font-body" style={{ fontSize: 10, color: palette.mutedGreige, lineHeight: 1.7 }}>
                      · {b}
                      {b === "Wholesale price not set" && (
                        <> — <Link href={specsHref} style={{ color: palette.goldDeep, textDecoration: "underline" }}>Set price</Link></>
                      )}
                    </li>
                  ))}
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
                title={portal === "shopify" ? "Creates or updates a DRAFT product — photos, copy, the retail price, one tracked variant per size (SKU + barcode) and the five product metafields. Going live stays a human act inside Shopify." : undefined}
              >
                {t?.state === "changes_pending" ? "Re-push" : "Push"} {portal === "wholesale" ? "wholesale" : "Shopify"}
              </button>

              {/* Unpublish — only once it is actually out there (Ansh, 22 Sep).
                  Wholesale takes it out of the buyer catalog; Shopify sets the
                  product to DRAFT, because a published product cannot be
                  un-created and deleting it would throw away the handle, the
                  URL and anything a customer has bookmarked. Either way the
                  work survives and a later push reconciles the same product. */}
              {(t?.state === "live" || t?.state === "changes_pending") && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(
                      portal === "wholesale"
                        ? "Take this out of the buyer catalog? Staff can still bill it at the counter, and its photos and description stay — pushing again puts it straight back."
                        : "Set this Shopify product back to DRAFT? It disappears from the storefront but keeps its URL, variants and metafields, and pushing again updates the same product.",
                    )) return;
                    run(() => unpublishDesign(board.id, portal), portal === "wholesale" ? "Taken out of the catalog" : "Set to draft in Shopify");
                  }}
                  className="mt-1.5 w-full font-body uppercase disabled:opacity-40"
                  style={{ fontSize: 8.5, letterSpacing: "0.12em", background: "transparent", color: "#9C3A31", border: "1px solid #9C3A31", padding: "7px 0" }}
                >
                  {portal === "wholesale" ? "Unpublish from catalog" : "Unpublish (set to draft)"}
                </button>
              )}
            </details>
          );
        })}
      </div>

      {/* Retire the product (0063). Down here with the portal controls rather
          than up beside Save, because it is the one button on this page that
          takes a garment out of circulation. Not offered when it is already
          retired — the banner at the top owns that state and its restore. */}
      {!board.discontinuedAt && (
        <div className="mt-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const note = window.prompt(
                "Discontinue this product?\n\nIt leaves the studio board (a Show discontinued switch brings it back) and comes out of the buyer catalog. It stays sellable at the counter and every past order keeps working.\n\nReason (optional):",
                "",
              );
              // prompt returns null on Cancel and "" on OK with nothing typed —
              // only the first is a refusal.
              if (note === null) return;
              // Not run(): its success message is fixed, and the one thing
              // worth saying here varies — a product still ACTIVE in Shopify
              // is half-retired, and silence would let that pass.
              startTransition(async () => {
                const res = await setDiscontinued(board.id, true, note);
                if (!res.ok) { flash(res.error ?? "Failed"); return; }
                flash(
                  res.shopifyLive
                    ? "Discontinued — still ACTIVE in Shopify, use Unpublish to set it to draft"
                    : `Discontinued${res.hiddenSkus ? ` · ${res.hiddenSkus} variant(s) out of the catalog` : ""}`,
                );
                router.refresh();
              });
            }}
            className="font-body uppercase disabled:opacity-40"
            style={{ fontSize: 9, letterSpacing: "0.12em", border: "1px solid #9C3A31", color: "#9C3A31", background: "transparent", padding: "7px 12px" }}
          >
            Discontinue this product
          </button>
        </div>
      )}

      {/* Background (Ansh, 19 Sep) — ONE look per design, in three modes.
          Row 1 picks the mode; row 2 appears only for Coloured, where the six
          chips are the deterministic Auto plus the five plates. Auto resolves
          from the design itself, so every angle and every regeneration of one
          outfit match; a plate chip pins it outright. */}
      <div className="mt-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Background</span>
          {(["minimal", "grey", "coloured"] as const).map((m) => (
            <button
              key={m}
              type="button"
              // A mode button that is already lit must be a NO-OP. Coloured is
              // the one that bites: its mode value is 'auto', so re-clicking
              // the lit Coloured chip while the design sits on an explicit
              // plate ('midnight', say) would silently throw that pick away
              // and re-roll the backdrop. The pick lives one row down.
              disabled={pending || bg.mode === m}
              onClick={() => run(() => setBgStyle(board.id, BG_MODE_DEFAULT[m]), `Background → ${BG_MODE_LABEL[m]}`)}
              className="flex items-center gap-1.5 font-body uppercase"
              title={BG_CAPTION[m]}
              style={chipStyle(bg.mode === m)}
            >
              {/* Coloured has no colour of its own until one is resolved, so
                  its dot shows the plate this design would actually get. */}
              {swatchDot(BG_MODE_SWATCH[m] ?? resolveBackground(bgStyle === "minimal" || bgStyle === "grey" ? "auto" : bgStyle, bgSeed).swatch, bg.mode === m)}
              {/* "rec" rather than "recommended": the chip row already wraps
                  at this size, and the tooltip and caption both spell it out. */}
              {BG_MODE_LABEL[m]}{m === "minimal" ? " · rec" : ""}
            </button>
          ))}
        </div>

        {/* Coloured only: Auto (deterministic) + the five plates. */}
        {bg.mode === "coloured" && (
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <button type="button" disabled={pending} onClick={() => run(() => setBgStyle(board.id, "auto"), "Background → auto")} className="flex items-center gap-1.5 font-body uppercase" style={chipStyle(bgStyle === "auto")}>
              {swatchDot(resolveBackground("auto", bgSeed).swatch, bgStyle === "auto")}
              Auto · {resolveBackground("auto", bgSeed).label}
            </button>
            {BG_COLOURS.map((c) => (
              <button key={c.key} type="button" disabled={pending} onClick={() => run(() => setBgStyle(board.id, c.key), `Background → ${c.label}`)} className="flex items-center gap-1.5 font-body uppercase" style={chipStyle(bgStyle === c.key)}>
                {swatchDot(c.swatch, bgStyle === c.key)}
                {c.label}
              </button>
            ))}
          </div>
        )}

        <div className="font-body mt-1.5" style={{ fontSize: 9.5, color: palette.mutedGreige, lineHeight: 1.5 }}>
          {BG_CAPTION[bg.mode]}
          {/* The sentence that used to sit here said detail close-ups fall back
              to white and never receive the plate. That carve-out went on 19 Sep
              ("They shall be treated exactly like the other 4") and regenAngle
              has sent them the plate ever since — leaving the claim up would
              have told Grishma a coloured backdrop cannot reach a close-up. */}
          {bg.mode === "coloured" && " All six angles get the same plate, close-ups included."}
          {" "}Changing this affects NEW generations; images already in production stay as they are.
        </div>
      </div>

      <JobsTicker />

      <div className="mt-4 flex flex-col gap-2 pb-10">
        {Object.keys(prompts).length > 0 && <DraftNotice meta={promptsMeta} label="Unsaved prompt edits restored" />}
        {angles.filter((a) => (AI_ANGLES as readonly string[]).includes(a.angle)).map(angleCard)}
        <div className="font-body uppercase mt-2" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Detail · macro</div>
        {angles.filter((a) => !(AI_ANGLES as readonly string[]).includes(a.angle)).map(angleCard)}

        {/* Copy panel (§10) */}
        <div className="mt-2 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
          <div className="flex items-center justify-between">
            <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Copy</span>
            <span className="font-body uppercase px-2 py-0.5" style={{ fontSize: 8, letterSpacing: "0.1em", fontWeight: 600, background: copy.status === "approved" ? "#DFF0E4" : copy.status === "draft" ? "#F6E7CB" : palette.ivoryDeep, color: copy.status === "approved" ? "#1F6B45" : copy.status === "draft" ? "#8a6d1a" : palette.mutedGreige }}>
              {copy.status}
            </span>
          </div>

          {!board.specsVerified && (
            <div className="font-body mt-2" style={{ fontSize: 10.5, color: "#8a6d1a" }}>
              Awaiting Rakesh&apos;s specs — copy generation is locked until specs are verified (STRICT_SPEC_MODE).
            </div>
          )}

          {/* R6 §8 — vision controls: editable prompt (persisted per design),
              model selector and the cost estimate, all BEFORE the run. */}
          <div className="mt-2">
            <button type="button" onClick={() => setCopyPromptOpen((v) => !v)} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige }}>
              <ChevronDown size={11} style={{ transform: copyPromptOpen ? "rotate(180deg)" : "none" }} />
              Vision prompt{copy.promptEdited ? " · edited" : " · from specs"}
            </button>
            {copyPromptMeta.restored && <div className="mt-1.5"><DraftNotice meta={copyPromptMeta} label="Prompt draft restored" /></div>}
            {copyPromptOpen && (
              <div className="mt-1.5">
                <textarea
                  value={copyPrompt}
                  onChange={(e) => setCopyPrompt(e.target.value)}
                  rows={8}
                  className="w-full font-mono p-2"
                  style={{ fontSize: 10, lineHeight: 1.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black }}
                />
                <div className="flex flex-wrap gap-1.5 mt-1">
                  <button type="button" disabled={pending || copyPrompt === copy.prompt} onClick={() => run(() => setCopyPromptAction(board.id, copyPrompt), "Prompt saved", copyPromptMeta.clear)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.12em", border: `1px solid ${palette.black}`, color: palette.black, padding: "5px 9px" }}>
                    Save prompt
                  </button>
                  {copy.promptEdited && (
                    <button type="button" disabled={pending} onClick={() => run(() => setCopyPromptAction(board.id, ""), "Back to the spec-built default", () => { adoptNextPromptRef.current = true; copyPromptMeta.clear(); })} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.12em", color: palette.mutedGreige, padding: "5px 9px" }}>
                      Reset to default
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.mutedGreige }}>Model</span>
              <select
                value={copy.effectiveModel}
                disabled={pending}
                onChange={(e) => run(() => setCopyModel(board.id, e.target.value), "Model set")}
                className="font-body p-1.5"
                style={{ fontSize: 10.5, border: "1px solid rgba(26,26,26,0.15)", background: "#fff", color: palette.black }}
              >
                {COPY_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label} · {m.note}</option>
                ))}
              </select>
              <span className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
                {estimateLabel(copy.effectiveModel)} per run{copy.modelOverridden ? " · overridden" : ` · ${board.tier} default`}
              </span>
            </div>
          </div>

          {copy.status !== "none" ? (
            <div className="mt-2">
              {(copyServerMoved || copyMeta.restored) && (
                <div className="mb-1.5">
                  {copyServerMoved
                    ? <DraftNotice meta={{ ...copyMeta, restored: true, stale: true, dismiss: () => setCopyServerMoved(false), discard: adoptServerCopy }} />
                    : <DraftNotice meta={copyMeta} />}
                </div>
              )}
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
                {Object.entries(copy.tags).map(([k, v]) => (
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
                  <button type="button" disabled={pending} onClick={() => run(() => saveCopyEdit(board.id, { ...copyDraft, tags: copy.tags }), "Copy saved as draft", copyMeta.clear)} className="font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "7px 10px" }}>
                    Save edit
                  </button>
                )}
                {/* Approve-copy retired (17 Sep) — a saved draft with a title
                    and description already satisfies every gate; whoever
                    pushes reads it on the way. approveCopy stays exported. */}
                <button type="button" disabled={pending || !board.specsVerified} onClick={() => run(() => generateCopy(board.id), "Copy regenerated", copyRegenerated)} className="flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 10px" }} title={`One vision call · ${estimateLabel(copy.effectiveModel)}`}>
                  <RefreshCw size={11} /> Regen · {estimateLabel(copy.effectiveModel)}
                </button>
              </div>
              {!board.specsVerified && (
                <div className="font-body mt-1.5" style={{ fontSize: 9.5, lineHeight: 1.5, color: "#9C3A31" }}>
                  Blocked until specs are confirmed — open <Link href={withFrom(`/admin/studio/master/${board.id}`, here)} style={{ textDecoration: "underline" }}>Product Master</Link> and tick &ldquo;Confirmed by Rakesh&rdquo; under Specs.
                </div>
              )}
            </div>
          ) : (
            <>
              <button type="button" disabled={pending || !board.specsVerified} onClick={() => run(() => generateCopy(board.id), "Copy generated", copyRegenerated)} className="mt-2 flex items-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.ivory, padding: "8px 11px" }} title={`One vision call · ${estimateLabel(copy.effectiveModel)}`}>
                Generate copy · {estimateLabel(copy.effectiveModel)}
              </button>
              {!board.specsVerified && (
                <div className="font-body mt-1.5" style={{ fontSize: 9.5, lineHeight: 1.5, color: "#9C3A31" }}>
                  Blocked until specs are confirmed — open <Link href={withFrom(`/admin/studio/master/${board.id}`, here)} style={{ textDecoration: "underline" }}>Product Master</Link> and tick &ldquo;Confirmed by Rakesh&rdquo; under Specs.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {picker && (
        <ImagePicker
          pool={pool}
          title={picker.intent === "use" ? "Use an image directly" : "Choose a source"}
          onClose={() => setPicker(null)}
          onPick={(img) => {
            const { angleId, intent } = picker;
            setPicker(null);
            run(() => (intent === "use" ? applyImageDirectly(angleId, img.id) : setAngleSource(angleId, img.id)), intent === "use" ? "Set as production" : "Source set");
          }}
        />
      )}

      {crop && (
        <CropSheet
          fileRef={crop.fileRef}
          onCancel={() => setCrop(null)}
          onCropped={(blob) => {
            const c = crop;
            setCrop(null);
            startTransition(async () => {
              const fd = new FormData();
              fd.set("photo", new File([blob], "crop.jpg", { type: "image/jpeg" }));
              const r = await saveCrop(c.angleId, board.id, c.parentId, fd);
              flash(r.ok ? "Crop saved" : r.error ?? "Crop failed");
              if (r.ok) router.refresh();
            });
          }}
        />
      )}

      {compare && (
        <CompareSheet
          leftRef={compare.left}
          rightRef={compare.right}
          leftLabel={compare.leftLabel}
          rightLabel={compare.rightLabel}
          onClose={() => setCompare(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
