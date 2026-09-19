"use client";

import { useState } from "react";
import { X, Download } from "lucide-react";
import { palette } from "@/lib/palette";

// Golden rule: every photo on the portal is clickable → full-screen zoom, so
// staff can identify an outfit from any thumbnail. Renders above modals (z-70).
//
// The zoom is also where a photo is SAVED (20 Sep). The card is a 150px tile
// on a phone in a stockroom with a dense row of 8pt buttons under it; the
// overlay is empty, already the full-resolution view, and already the gesture
// an operator uses to look closer — so the download lives here and costs the
// card nothing. Pass `downloadHref` to offer it; without one the overlay is
// exactly what it was.
export function Lightbox({ src, alt = "Photo", onClose, downloadHref }: { src: string; alt?: string; onClose: () => void; downloadHref?: string }) {
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
      <div className="absolute flex items-center gap-4" style={{ top: 16, right: 16 }}>
        {downloadHref && (
          <a
            href={downloadHref}
            // No value: the route sends Content-Disposition with the real name
            // (SKU · colour · angle · kind), so leaving the attribute empty
            // keeps ONE source of truth for the filename. The attribute is
            // still here because it is what makes a same-origin link save
            // rather than navigate when the header is ignored.
            download
            // Anything in this overlay bubbles to the backdrop, which closes
            // it — harmless for a download already in flight, but the overlay
            // vanishing under the operator's thumb reads as an error.
            onClick={(e) => e.stopPropagation()}
            aria-label={alt ? `Download photo of ${alt}` : "Download photo"}
            title="Download the full-resolution file"
            style={{ color: palette.ivory, lineHeight: 0 }}
          >
            <Download size={22} />
          </a>
        )}
        <button type="button" onClick={onClose} aria-label="Close" style={{ color: palette.ivory, lineHeight: 0 }}>
          <X size={26} />
        </button>
      </div>
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
  downloadHref,
}: {
  src: string;
  zoomSrc?: string; // larger variant for the overlay; defaults to src
  alt?: string;
  width: number;
  height: number;
  className?: string;
  downloadHref?: string; // offered inside the zoom, not on the thumbnail
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
      {open && <Lightbox src={zoomSrc ?? src} alt={alt} onClose={() => setOpen(false)} downloadHref={downloadHref} />}
    </>
  );
}
