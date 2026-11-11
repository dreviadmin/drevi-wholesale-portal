import { describe, it, expect } from "vitest";
import { describeSync, SYNC_STALE_MS } from "./sync-stamp";

// Audit round 2: Home printed only the clock time of the last sync, so a sync
// failing for days still looked fresh.

// 4 Oct 2026, 15:00 IST.
const NOW = new Date("2026-10-04T09:30:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("describeSync", () => {
  it("a recent sync reads as before: time only, not stale", () => {
    const s = describeSync(minutesAgo(8), NOW);
    expect(s.stale).toBe(false);
    expect(s.ago).toBeNull();
    expect(s.when).toMatch(/^2:52\s?pm$/i);
  });

  it("exactly at the threshold is still fresh; one minute past is stale", () => {
    expect(describeSync(minutesAgo(SYNC_STALE_MS / 60_000), NOW).stale).toBe(false);
    const s = describeSync(minutesAgo(31), NOW);
    expect(s.stale).toBe(true);
    expect(s.ago).toBe("31 min ago");
  });

  it("hours ago, same IST day: time only, with the age", () => {
    const s = describeSync(minutesAgo(5 * 60 + 10), NOW);
    expect(s).toMatchObject({ stale: true, ago: "5 h ago" });
    expect(s.when).toMatch(/^9:50\s?am$/i);
  });

  it("an earlier day carries the date, so it cannot pass for today", () => {
    const s = describeSync("2026-10-02T05:10:00.000Z", NOW); // 2 Oct, 10:40 IST
    expect(s.stale).toBe(true);
    expect(s.ago).toBe("2 days ago");
    expect(s.when).toMatch(/^2 Oct, 10:40\s?am$/i);
  });

  it("the IST day decides 'today', not the UTC one", () => {
    // 4 Oct 00:20 IST is still 3 Oct in UTC — and it is today in Mumbai.
    const s = describeSync("2026-10-03T18:50:00.000Z", NOW);
    expect(s.when).toMatch(/^12:20\s?am$/i);
  });

  it("no sync on record is stale, not a blank", () => {
    expect(describeSync(null, NOW)).toEqual({ when: "—", stale: true, ago: null });
    expect(describeSync("not a date", NOW)).toEqual({ when: "—", stale: true, ago: null });
  });
});
