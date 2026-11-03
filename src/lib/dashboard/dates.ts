// IST calendar days for the dashboard. Everything is a yyyy-mm-dd string, so a
// server render and the browser agree whatever zone each one runs in: no Intl,
// no local getDay or setDate.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Range = "today" | "7d" | "30d" | "mtd" | "all" | "custom";
export interface Bounds { from: string | null; to: string | null }

/** The IST calendar day of an instant. Exhibition days run on India time. */
export function istDay(value: string | number): string {
  return new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A real calendar day this century or next. Anything else from a URL or a half-typed year is no date. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2000-01-01" || value > "2100-12-31") return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const toUtc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(ymd: string, days: number): string {
  return fromUtc(toUtc(ymd) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** Monday of the week holding this day. */
export function weekStart(ymd: string): string {
  const weekday = (new Date(toUtc(ymd)).getUTCDay() + 6) % 7;
  return addDays(ymd, -weekday);
}

export function lastDayOfMonth(ymd: string): string {
  return fromUtc(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7), 0));
}

/** "24 Sep" */
export function fmtDay(ymd: string): string {
  return `${+ymd.slice(8, 10)} ${MONTHS[+ymd.slice(5, 7) - 1]}`;
}

/** "24 Sep 2026" */
export function fmtDayYear(ymd: string): string {
  return `${fmtDay(ymd)} ${ymd.slice(0, 4)}`;
}

/** "Sep 2026" */
export function fmtMonth(ymd: string): string {
  return `${MONTHS[+ymd.slice(5, 7) - 1]} ${ymd.slice(0, 4)}`;
}

/** The days a date chip covers, or null when Custom has no dates yet (nothing matches). */
export function rangeBounds(range: Range, start: string, end: string, now: number): Bounds | null {
  const today = istDay(now);
  switch (range) {
    case "today": return { from: today, to: today };
    case "7d": return { from: addDays(today, -6), to: today };
    case "30d": return { from: addDays(today, -29), to: today };
    case "mtd": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "custom": return start || end ? { from: start || null, to: end || null } : null;
    default: return { from: null, to: null };
  }
}

export function inBounds(day: string, bounds: Bounds | null): boolean {
  if (!bounds) return false;
  if (bounds.from && day < bounds.from) return false;
  if (bounds.to && day > bounds.to) return false;
  return true;
}
