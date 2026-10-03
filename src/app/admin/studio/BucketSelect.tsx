"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { palette } from "@/lib/palette";
import { dropdownBuckets, mergeBuckets, sortBuckets, type StudioBucket } from "@/lib/studio/buckets";
import { addStudioBucket } from "./bucket-actions";

// The Studio bucket dropdown (0074): Not set, every bucket, "+ Add custom…".
// A native <select> on purpose — the phone's own picker is the best one on a
// shop floor, and it needs no positioning code.

const ADD = "__add__";
const PICK = "__pick__";

/**
 * The bucket list as this screen knows it: the server's list with anything
 * added or removed here layered on top, so a custom bucket shows in every
 * dropdown and filter chip the moment it is created — before any refresh.
 */
export function useBuckets(server: StudioBucket[]) {
  const [local, setLocal] = useState<StudioBucket[]>([]);
  // The overlay only bridges the gap until the server list catches up: every
  // add / remove revalidates the page, so the next server list already has
  // the change. Clearing it then means another admin's later remove or
  // restore is never masked by a stale local copy.
  useEffect(() => { setLocal([]); }, [server]);
  const buckets = useMemo(() => mergeBuckets(server, local), [server, local]);
  const remember = (b: StudioBucket) => setLocal((prev) => [...prev.filter((x) => x.key !== b.key), b]);

  /** Ask for a name, create (or reuse) the bucket. null = cancelled. */
  async function promptAndAdd(): Promise<{ bucket?: StudioBucket; error?: string; existed?: boolean } | null> {
    const label = window.prompt("Name the new bucket");
    if (label === null) return null;
    let r: Awaited<ReturnType<typeof addStudioBucket>> | undefined;
    try { r = await addStudioBucket(label); } catch { r = undefined; }
    if (!r?.ok || !r.bucket) return { error: r?.error ?? "Could not add the bucket — check the connection" };
    remember(r.bucket);
    return { bucket: r.bucket, existed: r.existed };
  }

  return { buckets, remember, promptAndAdd };
}

export function BucketSelect({
  value,
  buckets,
  onPick,
  onAdd,
  disabled,
  ariaLabel,
  variant = "row",
}: {
  value: string | null;
  buckets: StudioBucket[];
  onPick: (key: string | null) => void;
  onAdd: () => void;
  disabled?: boolean;
  ariaLabel: string;
  /** row: a design's own bucket. batch: "Set bucket…" on the dark selection bar. */
  variant?: "row" | "batch";
}) {
  const batch = variant === "batch";
  // Arrowing through a closed select fires a change per step on some
  // browsers; stepping onto "+ Add custom…" must not throw a prompt at the
  // user. Enter, a click or a tap still opens it.
  const lastKey = useRef<string | null>(null);
  const options = batch ? sortBuckets(buckets.filter((b) => b.active)) : dropdownBuckets(buckets, value);
  const unset = !batch && !value;
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={batch ? PICK : value ?? ""}
      onKeyDown={(e) => { lastKey.current = e.key; }}
      onPointerDown={() => { lastKey.current = null; }}
      onChange={(e) => {
        const v = e.target.value;
        const stepped = !!lastKey.current && /^(Arrow|Page|Home$|End$)/.test(lastKey.current);
        lastKey.current = null;
        if (v === PICK) return;
        if (v === ADD) { if (!stepped) onAdd(); return; }
        onPick(v === "" ? null : v);
      }}
      onClick={(e) => e.stopPropagation()}
      className="font-body disabled:opacity-50"
      style={
        batch
          ? { fontSize: 9.5, letterSpacing: "0.06em", padding: "7px 6px", color: palette.ivory, background: palette.black, border: `1px solid ${palette.champagne}`, maxWidth: 170 }
          : {
              // minWidth 0: a native select sizes to its longest option, and one
              // 40-character custom bucket would otherwise widen every card.
              fontSize: 11, padding: "5px 6px", maxWidth: "100%", minWidth: 0, textOverflow: "ellipsis",
              border: `1px solid ${unset ? "rgba(26,26,26,0.15)" : palette.goldDeep}`,
              background: unset ? "#fff" : palette.ivoryDeep,
              color: unset ? palette.mutedGreige : palette.black,
              fontWeight: unset ? 400 : 600,
            }
      }
    >
      {batch && <option value={PICK}>Set bucket…</option>}
      <option value="">{batch ? "Not set (clear)" : "Not set"}</option>
      {options.map((b) => (
        <option key={b.key} value={b.key}>{b.active ? b.label : `${b.label} (removed)`}</option>
      ))}
      <option value={ADD}>+ Add custom…</option>
    </select>
  );
}
