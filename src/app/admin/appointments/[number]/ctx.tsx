"use client";

// One place for the booking page's mutations: every change carries the
// booking's current rev, a refusal (someone else changed it, a time that is
// now full) is shown as the action returned it, and the page is refreshed
// either way so what is on screen is what is stored.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import type { Appt, ApptType, Closure, HoursRow } from "@/lib/appointments/core";
import { changeAppointment, type ChangeInput } from "../actions";

export type Result = { ok: true; rev?: number } | { ok: false; error: string };
export interface StaffLite { id: string; name: string }

export interface BookingData {
  appt: Appt; types: ApptType[]; staff: StaffLite[]; isAdmin: boolean; today: string; nowIso: string;
  automationOn: boolean; testMode: boolean; hours: HoursRow[]; closures: Closure[];
}
interface Ctx extends BookingData {
  rev: number; now: Date; type: ApptType | null;
  busy: string | null;
  errorFor: (key: string) => string | null;
  clearError: () => void;
  run: (key: string, fn: () => Promise<Result>, okMsg?: string) => Promise<boolean>;
  change: (key: string, input: Omit<ChangeInput, "id" | "rev">, okMsg?: string) => Promise<boolean>;
  flash: (m: string) => void;
}

const BookingCtx = createContext<Ctx | null>(null);
export function useBooking(): Ctx {
  const c = useContext(BookingCtx);
  if (!c) throw new Error("useBooking outside BookingProvider");
  return c;
}

const OFFLINE = "Could not reach the server. Check the connection and try again.";

export function BookingProvider({ data, children }: { data: BookingData; children: ReactNode }) {
  const router = useRouter();
  const [toast, flash] = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ key: string; text: string } | null>(null);
  // The action answers with the new rev before the refreshed page lands; a
  // second change in that gap must not be refused as stale. Revs only grow.
  const [localRev, setLocalRev] = useState(data.appt.rev);
  const rev = Math.max(localRev, data.appt.rev);

  const run = useCallback(async (key: string, fn: () => Promise<Result>, okMsg?: string) => {
    setBusy(key); setErr(null);
    try {
      const res = await fn();
      if (!res.ok) { setErr({ key, text: res.error }); router.refresh(); return false; }
      if (typeof res.rev === "number") { const r = res.rev; setLocalRev((x) => Math.max(x, r)); }
      if (okMsg) flash(okMsg);
      router.refresh();
      return true;
    } catch {
      setErr({ key, text: OFFLINE });
      return false;
    } finally {
      setBusy(null);
    }
  }, [router, flash]);

  const change = useCallback(
    (key: string, input: Omit<ChangeInput, "id" | "rev">, okMsg?: string) => run(key, () => changeAppointment({ ...input, id: data.appt.id, rev } as ChangeInput), okMsg),
    [run, data.appt.id, rev],
  );

  const value = useMemo<Ctx>(() => ({
    ...data, rev, now: new Date(data.nowIso), type: data.types.find((t) => t.id === data.appt.type_id) ?? null,
    busy, errorFor: (k: string) => (err && err.key === k ? err.text : null), clearError: () => setErr(null), run, change, flash,
  }), [data, rev, busy, err, run, change, flash]);

  return (
    <BookingCtx.Provider value={value}>
      {children}
      {toast ? (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2 flex items-center gap-2" style={{ background: palette.black, color: palette.ivory, fontSize: 13, maxWidth: "calc(100vw - 32px)" }}>
          <Check size={14} color={palette.gold} aria-hidden /> {toast}
        </div>
      ) : null}
    </BookingCtx.Provider>
  );
}
