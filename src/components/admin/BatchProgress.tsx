"use client";

import { palette } from "@/lib/palette";

// A bulk run in the studio is not quick: copy generation is one vision call per
// design, and 100 designs took 17 minutes on 21 Sep. Until now the only sign it
// was alive was a toast between chunks — nothing at all for the ~100 seconds
// each chunk takes (Ansh, 22 Sep: "You definately need to add a status meter").
//
// So this stays on screen for the whole run: what is running, how far through,
// and the running tally. It is deliberately not a spinner — a spinner says
// "something is happening", and the question during a 17-minute job is "how
// much longer".

export interface BatchProgressState {
  /** "Generating copy", "Pushing to Shopify" — what is running, present tense. */
  label: string;
  done: number;
  total: number;
  /** The running tally: "25 generated · 5 awaiting specs". */
  detail?: string;
  /** Set when the run has finished; the bar stays up so the result is readable. */
  finished?: boolean;
  /** Set once Stop has been pressed and the loop is finishing its current chunk. */
  stopping?: boolean;
}

export function BatchProgress({
  state, onDismiss, onStop,
}: {
  state: BatchProgressState | null;
  onDismiss?: () => void;
  /** Halts the run after the chunk in flight. Without this the only way to
   *  stop a bulk job was to close the tab, because the loop lives in the
   *  browser and each chunk is a server action already on its way (Ansh,
   *  22 Sep: "Stop the Bulk Copy generation - Immediately"). */
  onStop?: () => void;
}) {
  if (!state) return null;
  const total = Math.max(1, state.total);
  const pct = Math.min(100, Math.round((state.done / total) * 100));

  // Deliberately NOT positioned here. The batch bar it sits above wraps onto a
  // second row of buttons at narrow widths, so any fixed offset guessed from
  // its height is wrong half the time — it overlapped the buttons on the first
  // run. The caller stacks this and the bar in one flex column instead.
  return (
    <div className="w-full">
      <div style={{ background: palette.black, boxShadow: "0 6px 24px rgba(0,0,0,0.35)", padding: "10px 12px" }}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.16em", color: palette.champagne }}>
            {state.finished ? `${state.label} — done` : state.label}
          </span>
          <div className="flex items-baseline gap-3">
            <span className="font-body" style={{ fontSize: 11, color: palette.ivory, fontVariantNumeric: "tabular-nums" }}>
              {state.done} / {state.total}
              <span style={{ color: palette.mutedGreige }}> · {pct}%</span>
            </span>
            {!state.finished && onStop && (
              <button
                type="button"
                onClick={onStop}
                disabled={state.stopping}
                className="font-body uppercase disabled:opacity-50"
                style={{ fontSize: 9, letterSpacing: "0.12em", border: "1px solid #E08A80", color: "#E08A80", background: "transparent", padding: "4px 9px" }}
              >
                {state.stopping ? "Stopping…" : "Stop"}
              </button>
            )}
          </div>
        </div>

        {/* The meter. aria-valuenow so a screen reader gets the same number. */}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.done}
          aria-label={state.label}
          style={{ height: 4, background: "rgba(255,255,255,0.15)", marginTop: 7 }}
        >
          <div style={{ height: "100%", width: `${pct}%`, background: state.stopping ? "#E08A80" : state.finished ? palette.champagne : palette.gold, transition: "width 240ms ease-out" }} />
        </div>

        {state.detail && (
          <div className="font-body mt-1.5" style={{ fontSize: 10.5, color: palette.mutedGreige }}>{state.detail}</div>
        )}
        {state.stopping && !state.finished && (
          <div className="font-body mt-1" style={{ fontSize: 10, color: "#E08A80" }}>
            Finishing the designs already sent — no new ones will start.
          </div>
        )}
        {state.finished && onDismiss && (
          <button type="button" onClick={onDismiss} className="font-body uppercase mt-1.5"
            style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.champagne, background: "transparent", border: "none", padding: 0 }}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
