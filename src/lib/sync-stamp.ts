// Home's "Synced HH:MM IST" stamp, honest about its age (audit round 2).
//
// The stamp is max(wholesale_products.synced_at): every successful sync run
// rewrites it on all rows, and the run fires every 10 minutes
// (.github/workflows/sync-cron.yml). It used to print only the clock time, so
// a sync that had been failing since Tuesday still read "Synced 10:40 am IST"
// — indistinguishable from ten minutes ago. Past SYNC_STALE_MS it now says how
// long ago it was (with the date when it was not today) and Home shows it as a
// warning.
//
// Pure, so sync-stamp.test.ts can pin the clock.

/** Three missed 10-minute runs. */
export const SYNC_STALE_MS = 30 * 60 * 1000;

export interface SyncStamp {
  /** "10:40 am" — or "2 Oct, 10:40 am" when not today (IST); "—" when unknown. */
  when: string;
  /** Older than SYNC_STALE_MS, or no sync on record at all. */
  stale: boolean;
  /** "45 min ago" / "3 h ago" / "2 days ago" — only when stale and known. */
  ago: string | null;
}

const istDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export function describeSync(syncedAt: string | null | undefined, now: Date = new Date()): SyncStamp {
  const at = syncedAt ? new Date(syncedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return { when: "—", stale: true, ago: null };

  const time = at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  const when = istDay(at) === istDay(now)
    ? time
    : `${at.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}, ${time}`;
  const ageMs = now.getTime() - at.getTime();
  const stale = ageMs > SYNC_STALE_MS;
  return { when, stale, ago: stale ? agoLabel(ageMs) : null };
}

function agoLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
