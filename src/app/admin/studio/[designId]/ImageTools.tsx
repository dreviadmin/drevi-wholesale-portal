"use client";

import { useEffect, useRef, useState } from "react";
import { X, Crop as CropIcon, Columns2, MoveHorizontal, RotateCcw, RotateCw } from "lucide-react";
import { palette } from "@/lib/palette";
import type { DesignImage } from "@/lib/studio/load";

// Retrofit R5 — the three shared image surfaces:
//   §7.2 ImagePicker  · every design image, grouped by role, archived behind a toggle
//   §7.3 CropSheet    · 4:5 / 1:1 / free, client-side, uploads a new derived image
//   §7.4 CompareSheet · side-by-side (default) and slider overlay, both zoomable

export const drivePhoto = (id: string, s = 600) => `/api/drive-photo?id=${encodeURIComponent(id)}&s=${s}`;

const ROLE_ORDER = ["source", "candidate", "import", "crop", "ident"] as const;
const ROLE_LABEL: Record<string, string> = {
  source: "Sources", candidate: "Generated", import: "Imported", crop: "Crops", ident: "Identification",
};

export function ImagePicker({
  pool, title, onPick, onClose,
}: {
  pool: DesignImage[];
  title: string;
  onPick: (img: DesignImage) => void;
  onClose: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const visible = pool.filter((i) => (showArchived ? true : i.status === "active"));

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.6)" }} onClick={onClose}>
      <div className="w-full md:w-[560px] max-h-modal overflow-y-auto p-4" style={{ background: palette.ivory }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>{title}</span>
          <button type="button" onClick={onClose} aria-label="Close"><X size={16} color={palette.softBlack} /></button>
        </div>
        <label className="flex items-center gap-2 mt-2 font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ accentColor: palette.goldDeep }} />
          Show archived / rejected
        </label>

        {ROLE_ORDER.map((role) => {
          const items = visible.filter((i) => i.role === role);
          if (items.length === 0) return null;
          return (
            <div key={role} className="mt-3">
              <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>
                {ROLE_LABEL[role]} · {items.length}
              </div>
              <div className="grid grid-cols-4 gap-2 mt-1.5">
                {items.map((img) => (
                  <button key={img.id} type="button" onClick={() => onPick(img)} className="text-left">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={drivePhoto(img.fileRef, 300)} alt={img.role} style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", background: palette.ivoryDeep, opacity: img.status === "active" ? 1 : 0.45 }} />
                    <span className="font-mono block truncate" style={{ fontSize: 7.5, color: palette.mutedGreige }}>
                      {img.angle ?? "design"}{img.engine && img.engine !== "raw" ? ` · ${img.engine}` : ""}
                    </span>
                    <span className="font-body block" style={{ fontSize: 7, color: palette.mutedGreige }}>
                      {new Date(img.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}{img.status !== "active" ? ` · ${img.status}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="font-body py-8 text-center" style={{ fontSize: 12, color: palette.mutedGreige }}>No images on this design yet.</div>
        )}
      </div>
    </div>
  );
}

const PRESETS = [
  { key: "4:5", label: "4:5 · model", ratio: 4 / 5 },
  { key: "1:1", label: "1:1 · shopping", ratio: 1 },
  { key: "free", label: "Free", ratio: null as number | null },
];

export function CropSheet({
  fileRef, onCancel, onCropped,
}: {
  fileRef: string;
  onCancel: () => void;
  onCropped: (blob: Blob) => void;
}) {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Rotation bakes a new bitmap and swaps the <img> src, so the pan/zoom and
  // save math never need to know the image was turned (Ansh, 30 Jul).
  const [srcOverride, setSrcOverride] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  function onDown(e: React.PointerEvent) { drag.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }; }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setOffset({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
  }
  function onUp() { drag.current = null; }

  function rotate(dir: 1 | -1) {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const c = document.createElement("canvas");
    c.width = img.naturalHeight;
    c.height = img.naturalWidth;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((dir * Math.PI) / 2);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    c.toBlob((b) => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      setSrcOverride((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    }, "image/png");
  }

  // Draw exactly what the frame shows into a canvas — the original file on
  // Drive is never modified (§7.3).
  async function apply() {
    const img = imgRef.current, box = boxRef.current;
    if (!img || !box) return;
    setBusy(true);
    const rect = box.getBoundingClientRect();
    const out = document.createElement("canvas");
    const scale = 1200 / rect.width;
    out.width = Math.round(rect.width * scale);
    out.height = Math.round(rect.height * scale);
    const ctx = out.getContext("2d");
    if (!ctx) { setBusy(false); return; }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    const natural = { w: img.naturalWidth, h: img.naturalHeight };
    const drawnW = rect.width * zoom;
    const drawnH = (natural.h / natural.w) * drawnW;
    const dx = (rect.width - drawnW) / 2 + offset.x;
    const dy = (rect.height - drawnH) / 2 + offset.y;
    ctx.drawImage(img, dx * scale, dy * scale, drawnW * scale, drawnH * scale);
    out.toBlob((blob) => { setBusy(false); if (blob) onCropped(blob); }, "image/jpeg", 0.92);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,20,20,0.75)" }}>
      <div className="w-full md:w-[460px] p-4" style={{ background: palette.ivory }}>
        <div className="flex items-center justify-between">
          <span className="font-body uppercase flex items-center gap-1.5" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.softBlack }}>
            <CropIcon size={13} /> Crop &amp; rotate
          </span>
          <button type="button" onClick={onCancel} aria-label="Close"><X size={16} color={palette.softBlack} /></button>
        </div>

        <div className="flex gap-1.5 mt-2 items-center">
          <button type="button" onClick={() => rotate(-1)} aria-label="Rotate left" className="font-body" style={{ padding: "6px 8px", border: "1px solid rgba(26,26,26,0.15)", color: palette.softBlack }}>
            <RotateCcw size={13} />
          </button>
          <button type="button" onClick={() => rotate(1)} aria-label="Rotate right" className="font-body" style={{ padding: "6px 8px", border: "1px solid rgba(26,26,26,0.15)", color: palette.softBlack }}>
            <RotateCw size={13} />
          </button>
          <span style={{ width: 1, alignSelf: "stretch", background: "rgba(26,26,26,0.12)" }} />
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => setPreset(p)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "6px 9px", border: `1px solid ${preset.key === p.key ? palette.black : "rgba(26,26,26,0.15)"}`, background: preset.key === p.key ? palette.black : "transparent", color: preset.key === p.key ? palette.ivory : palette.softBlack }}>
              {p.label}
            </button>
          ))}
        </div>

        <div
          ref={boxRef}
          className="mt-3 overflow-hidden touch-none select-none"
          style={{ width: "100%", aspectRatio: preset.ratio ? String(preset.ratio) : "4/5", background: "#111", position: "relative", cursor: "grab" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={srcOverride ?? drivePhoto(fileRef, 1200)}
            alt="crop source"
            crossOrigin="anonymous"
            draggable={false}
            style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`, width: "100%", transformOrigin: "center" }}
          />
        </div>

        <label className="block mt-3 font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
          Zoom
          <input type="range" min="1" max="3" step="0.02" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full" style={{ accentColor: palette.goldDeep }} />
        </label>

        <div className="flex gap-2 mt-2">
          <button type="button" disabled={busy} onClick={apply} className="flex-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.black, color: palette.ivory, padding: "12px 0" }}>
            {busy ? "Saving…" : "Save crop"}
          </button>
          <button type="button" onClick={onCancel} className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.14em", color: palette.softBlack, padding: "12px 14px" }}>Cancel</button>
        </div>
        <div className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige }}>The original is never modified — a crop is saved as its own image.</div>
      </div>
    </div>
  );
}

export function CompareSheet({
  leftRef, rightRef, leftLabel, rightLabel, onClose,
}: {
  leftRef: string; rightRef: string; leftLabel: string; rightLabel: string; onClose: () => void;
}) {
  const [mode, setMode] = useState<"side" | "slider">("side");
  const [pos, setPos] = useState(50);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "rgba(12,12,12,0.94)" }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setMode("side")} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "7px 10px", background: mode === "side" ? palette.gold : "transparent", color: mode === "side" ? palette.black : palette.champagne, border: `1px solid ${palette.champagne}` }}>
            <Columns2 size={12} /> Side by side
          </button>
          <button type="button" onClick={() => setMode("slider")} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "7px 10px", background: mode === "slider" ? palette.gold : "transparent", color: mode === "slider" ? palette.black : palette.champagne, border: `1px solid ${palette.champagne}` }}>
            <MoveHorizontal size={12} /> Slider
          </button>
        </div>
        <button type="button" onClick={onClose} aria-label="Close"><X size={20} color={palette.champagne} /></button>
      </div>

      <div className="flex-1 min-h-0 px-3 pb-4">
        {mode === "side" ? (
          <div className="h-full grid grid-cols-2 gap-2">
            {[{ r: leftRef, l: leftLabel }, { r: rightRef, l: rightLabel }].map((x, i) => (
              <div key={i} className="flex flex-col min-h-0">
                <span className="font-body uppercase text-center" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.champagne, marginBottom: 4 }}>{x.l}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={drivePhoto(x.r, 1200)} alt={x.l} style={{ flex: 1, minHeight: 0, width: "100%", objectFit: "contain" }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <div className="relative flex-1 min-h-0 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={drivePhoto(leftRef, 1200)} alt={leftLabel} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
              <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 0 0 ${pos}%)` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={drivePhoto(rightRef, 1200)} alt={rightLabel} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              </div>
              <div style={{ position: "absolute", top: 0, bottom: 0, left: `${pos}%`, width: 2, background: palette.gold }} />
            </div>
            <input type="range" min="0" max="100" value={pos} onChange={(e) => setPos(Number(e.target.value))} className="w-full mt-3" style={{ accentColor: palette.gold }} />
            <div className="flex justify-between font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.champagne }}>
              <span>{leftLabel}</span><span>{rightLabel}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
