import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/wallet-core", () => ({ orderTagBlocker: () => null }));
const { metaEvent, sendMetaSchedule } = await import("./meta-capi");

const B = { number: "A-2001", typeId: "store", party: "solo", phoneE164: "+919876543210", createdAt: "2026-11-20T16:30:00.000Z",
  fbp: null as string | null, fbc: null as string | null, fbclid: null as string | null, ip: "203.0.113.7", userAgent: "Mozilla/5.0 (iPhone)" };

describe("Meta Conversions API: the Schedule event", () => {
  it("carries the booking number as event_id and the number hashed as digits with the country code", () => {
    const e = metaEvent(B);
    expect(e).toMatchObject({ event_name: "Schedule", event_id: "A-2001", action_source: "website", event_time: 1795192200, event_source_url: "https://drevifashion.com/pages/visit" });
    expect(e.user_data.ph).toEqual([createHash("sha256").update("919876543210").digest("hex")]);
    expect(e.user_data).toMatchObject({ client_ip_address: "203.0.113.7", client_user_agent: "Mozilla/5.0 (iPhone)" });
    expect(e.custom_data).toEqual({ content_name: "Store visit", visit_party: "solo" });
  });
  it("uses the page's cookies, or makes fbc from the ad's fbclid", () => {
    expect(metaEvent({ ...B, fbp: "fb.1.1.2", fbc: "fb.1.1.abc" }).user_data).toMatchObject({ fbp: "fb.1.1.2", fbc: "fb.1.1.abc" });
    expect(metaEvent({ ...B, fbclid: "IwAR0abc" }).user_data.fbc).toBe(`fb.1.${Date.parse(B.createdAt)}.IwAR0abc`);
    expect(metaEvent(B).user_data).not.toHaveProperty("fbc");
  });
  it("sends nothing without the access token", async () => {
    delete process.env.META_CAPI_TOKEN;
    const f = vi.spyOn(globalThis, "fetch");
    expect(await sendMetaSchedule(B)).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("posts to the shop's pixel with the token in the body, and reads Meta's answer", async () => {
    process.env.META_CAPI_TOKEN = "tok";
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ events_received: 1, fbtrace_id: "x" }), { status: 200 }));
    expect(await sendMetaSchedule(B)).toEqual({ ok: true, note: "Sent to Meta" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/1139607661846580/events");
    expect(url).not.toContain("tok");
    expect(JSON.parse(String(init.body))).toMatchObject({ access_token: "tok", data: [{ event_id: "A-2001" }] });
    f.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }));
    expect(await sendMetaSchedule(B)).toEqual({ ok: false, note: "Meta refused it (HTTP 400): Invalid parameter" });
    f.mockRestore();
    delete process.env.META_CAPI_TOKEN;
  });
});
