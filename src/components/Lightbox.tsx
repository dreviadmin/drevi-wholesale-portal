"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { palette } from "@/lib/palette";

// Golden rule: every photo on the portal is clickable → full-screen zoom, so
// staff can identify an outfit from any thumbnail. Renders above modals (z-70).
export function Lightbox({ src, alt = "Photo", onClose }: { src: string; alt?: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: "rgba(15,13,12,0.94)", padding: 16 }}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      role="button"
      aria-label="Close photo"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      <button type="button" onClick={onClose} aria-label="Close" className="absolute" style={{ top: 16, right: 16, color: palette.ivory }}>
        <X size={26} />
      </button>
    </div>
  );
}

// Self-contained zoomable thumbnail — drop-in wherever a photo is shown,
// including inside server components. Tapping opens the full image; the tap
// never bubbles to a surrounding row/card click.
export function ZoomImage({
  src,
  zoomSrc,
  alt = "",
  width,
  height,
  className = "",
}: {
  src: string;
  zoomSrc?: string; // larger variant for the overlay; defaults to src
  alt?: string;
  width: number;
  height: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={alt ? `Enlarge photo of ${alt}` : "Enlarge photo"}
        className={`relative flex-shrink-0 ${className}`}
        style={{ width, height, background: palette.ivoryDeep, cursor: "zoom-in", padding: 0, border: "none" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </button>
      {open && <Lightbox src={zoomSrc ?? src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
