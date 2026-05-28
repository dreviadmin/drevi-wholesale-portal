"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Store, Plus, ChevronRight } from "lucide-react";
import { startSession } from "./actions";
import { palette } from "@/lib/palette";

interface SessionDTO { id: string; event_name: string; started_at: string; ended_at: string | null; orders_count: number; }

function fmt(iso: string) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }

export function ExhibitionHome({ sessions }: { sessions: SessionDTO[] }) {
  const router = useRouter();
  const [event, setEvent] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function begin() {
    setError(null);
    start(async () => {
      const res = await startSession(event);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      router.push(`/admin/exhibition/${res.id}`);
    });
  }

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <h1 className="font-display flex items-center gap-2" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>
        <Store size={20} strokeWidth={1.6} /> Exhibitions
      </h1>
      <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>Tablet-first. Start a session, capture buyers, and build orders on the spot.</p>

      {!starting ? (
        <button type="button" onClick={() => setStarting(true)} className="mt-5 flex items-center gap-2 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 11, letterSpacing: "0.18em", padding: "12px 18px" }}>
          <Plus size={14} /> Start Exhibition Session
        </button>
      ) : (
        <div className="mt-5 flex flex-col gap-3 max-w-sm">
          <label className="flex flex-col gap-1.5">
            <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Event name</span>
            <input autoFocus value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. Bridal Asia 2026" className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 14 }} />
          </label>
          {error && <p className="font-body" style={{ fontSize: 11, color: palette.crimsonText }}>{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setStarting(false)} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>Cancel</button>
            <button type="button" onClick={begin} disabled={isPending || !event.trim()} className="font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>{isPending ? "Starting…" : "Begin"}</button>
          </div>
        </div>
      )}

      <h2 className="font-body uppercase mt-9" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.gold }}>Recent Sessions</h2>
      <div className="mt-2">
        {sessions.length === 0 ? (
          <p className="font-body" style={{ fontSize: 12, color: palette.mutedGreige }}>No sessions yet.</p>
        ) : sessions.map((s) => (
          <Link key={s.id} href={`/admin/exhibition/${s.id}`} className="flex items-center justify-between py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
            <div>
              <div className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>{s.event_name}</div>
              <div className="font-body mt-0.5" style={{ fontSize: 10, color: palette.mutedGreige }}>{fmt(s.started_at)} · {s.orders_count} order{s.orders_count === 1 ? "" : "s"} · {s.ended_at ? "Ended" : "Active"}</div>
            </div>
            <ChevronRight size={16} color={palette.mutedGreige} />
          </Link>
        ))}
      </div>
    </div>
  );
}
