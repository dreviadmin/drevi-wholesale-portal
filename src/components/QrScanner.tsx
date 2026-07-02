"use client";

import { useEffect, useRef, useState } from "react";
import { X, Keyboard, Check, ShoppingBag } from "lucide-react";
import { palette } from "@/lib/palette";

// Minimal typing for the native BarcodeDetector (Chrome/Android fast path).
interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => NativeBarcodeDetector;
  }
}

export interface ScanFeedback {
  ok: boolean;
  message: string;
}

const SAME_CODE_COOLDOWN_MS = 2500; // ignore re-reads of the same label
const GENERAL_COOLDOWN_MS = 700; // breathing room between different scans

/**
 * Full-screen CONTINUOUS QR scanner. Outfit QRs encode the bare SKU.
 *
 * Stays open across scans: each decode calls onScan and shows its feedback as
 * an overlay (with a beep + vibration on success), so staff can sweep through
 * a rack of outfits without reopening the camera. Re-reads of the same code
 * are debounced. "Done" closes.
 *
 * Decode strategy: native BarcodeDetector when available, else jsQR over
 * canvas frames (works on iOS Safari). Camera needs HTTPS or localhost — a
 * manual SKU field is always available as fallback.
 */
export function QrScanner({
  onScan,
  onClose,
  onGoToCart,
  title = "Scan outfit QRs",
}: {
  onScan: (text: string) => ScanFeedback;
  onClose: () => void;
  onGoToCart?: () => void;
  title?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [added, setAdded] = useState(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function beep(ok: boolean) {
    try {
      type AudioCtor = typeof AudioContext;
      const Ctx: AudioCtor | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = ok ? 1200 : 320;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (ok ? 0.09 : 0.18));
      osc.onended = () => ctx.close().catch(() => {});
    } catch {
      // audio unavailable — vibration/overlay still signal the result
    }
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
  }

  function handleCode(raw: string) {
    const code = raw.trim();
    if (!code) return;
    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.at < SAME_CODE_COOLDOWN_MS) return;
    if (now - lastRef.current.at < GENERAL_COOLDOWN_MS) return;
    lastRef.current = { code, at: now };

    const result = onScan(code);
    beep(result.ok);
    if (result.ok) setAdded((n) => n + 1);
    setFeedback(result);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1800);
  }

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera not available here — type the SKU below instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        setError("Camera permission denied or unavailable — type the SKU below instead.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const jsQR = detector ? null : (await import("jsqr")).default;

      const tick = async () => {
        if (cancelled) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length > 0 && codes[0].rawValue) handleCode(codes[0].rawValue);
            } else if (jsQR && ctx) {
              const w = 480;
              const h = Math.round((video.videoHeight / video.videoWidth) * w);
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const img = ctx.getImageData(0, 0, w, h);
              const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
              if (code?.data) handleCode(code.data);
            }
          } catch {
            // transient decode errors — keep scanning
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    stopRef.current = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    start();
    return () => stopRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const sku = manual.trim();
    if (!sku) return;
    lastRef.current = { code: "", at: 0 }; // manual entry always processes
    handleCode(sku);
    setManual("");
  }

  function close() {
    stopRef.current?.();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "rgba(15,13,12,0.96)" }}>
      <div className="flex items-center justify-between px-4 py-3.5">
        <span className="font-body uppercase" style={{ color: palette.champagne, fontSize: 11, letterSpacing: "0.22em" }}>
          {title}{added > 0 ? ` · ${added} added` : ""}
        </span>
        <button type="button" onClick={close} aria-label="Close scanner" style={{ color: palette.ivory }}>
          <X size={22} strokeWidth={1.7} />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center px-6">
        {error ? (
          <p className="font-body text-center" style={{ color: palette.champagne, fontSize: 13, lineHeight: 1.7, maxWidth: 320 }}>{error}</p>
        ) : (
          <div className="relative w-full max-w-md">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} playsInline muted className="w-full" style={{ aspectRatio: "3/4", objectFit: "cover", background: "#000" }} />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div style={{ width: "62%", aspectRatio: "1/1", border: `2px solid ${feedback ? (feedback.ok ? "#4C9A63" : palette.crimsonText) : palette.gold}`, boxShadow: "0 0 0 2000px rgba(15,13,12,0.35)", transition: "border-color 150ms" }} />
            </div>
            <p className="font-body text-center mt-3" style={{ color: palette.champagne, fontSize: 11, letterSpacing: "0.06em" }}>
              Keep scanning — each QR adds to the cart. Tap Done when finished.
            </p>
          </div>
        )}
      </div>

      {/* per-scan feedback — rendered at panel level so it also shows in
          manual-entry mode (no camera) */}
      {feedback && (
        <div className="px-6 pb-2 max-w-md w-full mx-auto">
          <div
            className="flex items-center gap-2 font-body"
            style={{ background: feedback.ok ? "#2E5941" : palette.crimsonText, color: palette.ivory, fontSize: 12, padding: "9px 16px" }}
          >
            {feedback.ok ? <Check size={14} strokeWidth={2.5} /> : <X size={14} strokeWidth={2.5} />}
            <span className="truncate">{feedback.message}</span>
          </div>
        </div>
      )}

      {/* manual fallback + done */}
      <div className="px-6 pb-8 max-w-md w-full mx-auto">
        <form onSubmit={submitManual} className="flex items-center gap-2">
          <Keyboard size={16} color={palette.champagne} strokeWidth={1.7} className="flex-shrink-0" />
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Or type the SKU"
            className="font-body bg-transparent outline-none flex-1"
            style={{ borderBottom: `1px solid rgba(232,213,183,0.4)`, color: palette.ivory, padding: "8px 2px", fontSize: 14 }}
          />
          <button type="submit" className="font-body uppercase" style={{ background: "transparent", color: palette.champagne, border: `1px solid rgba(232,213,183,0.4)`, fontSize: 10, letterSpacing: "0.15em", padding: "9px 14px" }}>
            Add
          </button>
        </form>
        <div className="flex gap-2 mt-4">
          {onGoToCart && added > 0 && (
            <button type="button" onClick={() => { stopRef.current?.(); onGoToCart(); }} className="flex-1 flex items-center justify-center gap-2 font-body uppercase" style={{ border: `1px solid ${palette.gold}`, color: palette.gold, fontSize: 11, letterSpacing: "0.18em", padding: "12px 0" }}>
              <ShoppingBag size={14} strokeWidth={2} /> Cart ({added})
            </button>
          )}
          <button type="button" onClick={close} className="flex-1 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 11, letterSpacing: "0.18em", padding: "12px 0" }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
