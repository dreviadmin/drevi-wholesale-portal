"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { palette } from "@/lib/palette";

// Live job chips (build guide §8.3): Realtime subscription on pipeline_jobs
// (staff-read RLS policy), polling fallback on mount. A finishing job
// refreshes the board so its results appear without a manual reload.

interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  log: string;
  finished_at: string | null;
}

export function JobsTicker() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const supa = createClient();
    let alive = true;

    async function refresh() {
      const { data } = await supa
        .from("pipeline_jobs")
        .select("id, type, status, progress, log, finished_at")
        .in("status", ["queued", "claimed", "running", "error"])
        .order("created_at", { ascending: false })
        .limit(6);
      if (alive && data) setJobs(data as JobRow[]);
    }
    refresh();

    const channel = supa
      .channel("pipeline-jobs")
      .on("postgres_changes", { event: "*", schema: "public", table: "pipeline_jobs" }, (payload) => {
        const row = payload.new as JobRow | undefined;
        if (row?.status === "done") {
          refresh();
          router.refresh(); // results are on the board now
        } else {
          refresh();
        }
      })
      .subscribe();
    // Realtime can miss while the tab sleeps — a slow poll keeps chips honest.
    const tick = setInterval(refresh, 15000);

    return () => {
      alive = false;
      clearInterval(tick);
      supa.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div className="mt-3 flex flex-col gap-1">
      {jobs.map((j) => {
        const running = j.status === "running" || j.status === "claimed";
        return (
          <button
            key={j.id}
            type="button"
            onClick={() => setExpanded(expanded === j.id ? null : j.id)}
            className="text-left p-2.5"
            style={{ background: palette.ivory, border: `1px solid ${j.status === "error" ? "#C97B7B" : "rgba(26,26,26,0.1)"}` }}
          >
            <span className="flex items-center gap-2">
              {j.status === "error" ? (
                <AlertTriangle size={13} color="#9C3A31" />
              ) : running ? (
                <Loader2 size={13} className="animate-spin" color={palette.goldDeep} />
              ) : (
                <CheckCircle2 size={13} color={palette.mutedGreige} />
              )}
              <span className="font-mono" style={{ fontSize: 11, color: palette.black }}>{j.type}</span>
              <span className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
                {j.status === "queued" ? "queued · ~15–40 s to start" : running ? `running ${j.progress}%` : j.status}
              </span>
            </span>
            {expanded === j.id && j.log && (
              <pre className="mt-2 overflow-x-auto font-mono" style={{ fontSize: 9.5, color: palette.softBlack, whiteSpace: "pre-wrap" }}>{j.log}</pre>
            )}
          </button>
        );
      })}
    </div>
  );
}
