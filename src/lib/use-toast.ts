"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One toast timer, one duration, for the whole admin.
//
// Ansh, 22 Sep: "the pipeline notifications in the portal are very quick, not
// even giving time to read." Two separate causes, and the second was the one
// that actually bit:
//
//   1. The ~20 hand-rolled `flash` helpers used 1500-3500ms. A line like
//      "Copy 30/102 · 25 generated · 5 awaiting specs" is 44 characters; 2200ms
//      is not enough to notice it, move your eyes and read it.
//
//   2. None of them cleared the PREVIOUS timer. During a bulk run messages
//      arrive every few seconds, so the timer from the previous message would
//      fire part-way through the new one and wipe it — a chunk-progress line
//      could be on screen for a couple of hundred milliseconds. That is why it
//      felt fastest exactly when there was most to read.
//
// Scaling with length matters because these messages differ by an order of
// magnitude: "Saved" needs a moment, a Shopify userError needs several seconds.

const MIN_MS = 4500;
const MAX_MS = 12000;
/** ~9 characters a second — a relaxed glance, not a careful read. */
const PER_CHAR_MS = 110;

export function toastDuration(message: string): number {
  return Math.min(MAX_MS, Math.max(MIN_MS, message.trim().length * PER_CHAR_MS));
}

/**
 * `const [toast, flash, dismiss] = useToast()`.
 *
 * flash() replaces whatever is showing and restarts the clock, so a run of
 * messages reads as a sequence instead of cutting each other short. The timer
 * is cleared on unmount, so a batch that finishes after the operator has
 * navigated away does not set state on a dead component.
 */
export function useToast(): [string | null, (message: string) => void, () => void] {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const flash = useCallback((message: string) => {
    stop();
    setToast(message);
    timer.current = setTimeout(() => { timer.current = null; setToast(null); }, toastDuration(message));
  }, [stop]);

  const dismiss = useCallback(() => { stop(); setToast(null); }, [stop]);

  useEffect(() => stop, [stop]);
  return [toast, flash, dismiss];
}
