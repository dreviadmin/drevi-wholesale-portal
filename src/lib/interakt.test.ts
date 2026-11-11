import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Who the staff alerts go to. INTERAKT_API_KEY is blanked in every test, so
// each send takes the logged no-op path — the log line names the number it
// would have gone to, and fetch is a spy that must never be called.

vi.mock("server-only", () => ({}));

const fetchSpy = vi.fn(async () => {
  throw new Error("interakt.test: no network");
});

async function load(alertPhone: string | undefined) {
  vi.stubEnv("INTERAKT_API_KEY", "");
  vi.stubEnv("INTERAKT_ALERT_PHONE", alertPhone);
  vi.resetModules(); // ALERT_PHONE is read when the module loads
  return await import("./interakt");
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  info.mockRestore();
  fetchSpy.mockClear();
});

const loggedTo = () => info.mock.calls.map((c: unknown[]) => String(c[0]));

describe("staff alert number", () => {
  it("keeps the number alerts have always gone to when INTERAKT_ALERT_PHONE is unset", async () => {
    const m = await load(undefined);
    await m.sendInquiryAlert("Royal Boutique", "Pune");
    await m.sendPendingReviewAlert(3, "Surat expo");
    await m.sendOrderAlert("DW-0001", "Royal Boutique", "₹12,000", "portal");
    expect(loggedTo()).toEqual([
      '[interakt] skipped "wholesale_inquiry_alert" to 918828043555 (no INTERAKT_API_KEY)',
      '[interakt] skipped "wholesale_pending_review" to 918828043555 (no INTERAKT_API_KEY)',
      '[interakt] skipped "wholesale_order_alert" to 918828043555 (no INTERAKT_API_KEY)',
    ]);
  });

  it("uses INTERAKT_ALERT_PHONE when set, keeping digits only", async () => {
    const m = await load("+91 98200-12345");
    await m.sendInquiryAlert("Royal Boutique", "Pune");
    expect(loggedTo()).toEqual(['[interakt] skipped "wholesale_inquiry_alert" to 919820012345 (no INTERAKT_API_KEY)']);
  });

  it("falls back to the built-in number when the env value has no digits", async () => {
    const m = await load("  none  ");
    await m.sendOrderAlert("DW-0001", "Royal Boutique", "₹12,000", "portal");
    expect(loggedTo()).toEqual(['[interakt] skipped "wholesale_order_alert" to 918828043555 (no INTERAKT_API_KEY)']);
  });

  it("does not touch the buyer's own order confirmation", async () => {
    const m = await load("919820012345");
    const res = await m.sendOrderConfirmation("9876543210", "DW-0001", "₹12,000", "https://example.test/o.pdf");
    expect(res).toEqual({ sent: false, skipped: true, channel: "whatsapp" });
    expect(loggedTo()).toEqual(['[interakt] skipped "wholesale_order_confirmation" to 9876543210 (no INTERAKT_API_KEY)']);
  });
});
