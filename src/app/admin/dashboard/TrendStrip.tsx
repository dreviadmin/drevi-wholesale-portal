"use client";

import { useState } from "react";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { fmtDay } from "@/lib/dashboard/dates";
import type { TrendBucket } from "@/lib/dashboard/trend";

const HEIGHT = 56;

/** One series over time, so the title names it and it needs no legend. */
export function TrendStrip({ buckets, title, onPick }: {
  buckets: TrendBucket[];
  title: string;
  onPick: (bucket: TrendBucket) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  // A trend needs at least two points: one sale stretched over six weeks is noise.
  if (buckets.length < 3 || buckets.filter((b) => b.amount > 0).length < 2) return null;
  const peak = Math.max(...buckets.map((b) => b.amount), 1);
  const bucket = picked != null ? buckets[picked] : null;
  const unit = bucket ? (bucket.from === bucket.to ? "day" : "period") : "";

  return (
    <figure className="mt-3 mx-0 mb-0">
      <figcaption className="flex items-baseline justify-between gap-3 font-body" style={{ fontSize: 10.5, color: palette.mutedGreige, minHeight: 22 }}>
        {bucket ? (
          <>
            <span><span style={{ color: palette.black, fontWeight: 600 }}>{formatINR(bucket.amount)}</span> · {bucket.label}</span>
            <button type="button" onClick={() => { setPicked(null); onPick(bucket); }} className="font-body uppercase flex-none" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>
              Show only this {unit}
            </button>
          </>
        ) : (
          <>
            <span>{title}</span>
            <span>{fmtDay(buckets[0].from)} to {fmtDay(buckets[buckets.length - 1].to)}</span>
          </>
        )}
      </figcaption>
      <div className="flex items-end" style={{ height: HEIGHT, gap: buckets.length > 40 ? 1 : 2, borderBottom: "1px solid rgba(26,26,26,0.15)" }}>
        {buckets.map((b, i) => (
          <button
            key={b.from}
            type="button"
            title={`${b.label}: ${formatINR(b.amount)}`}
            aria-label={`${b.label}: ${formatINR(b.amount)}`}
            aria-pressed={picked === i}
            onClick={() => setPicked(picked === i ? null : i)}
            className="flex-1 min-w-0 flex items-end h-full"
            style={{ padding: 0, background: "none" }}
          >
            {b.amount > 0 && (
              <span
                className="block w-full"
                style={{
                  height: Math.max(3, Math.round((b.amount / peak) * HEIGHT)),
                  background: picked === i ? palette.black : palette.goldDeep,
                  borderRadius: "2px 2px 0 0",
                }}
              />
            )}
          </button>
        ))}
      </div>
    </figure>
  );
}
