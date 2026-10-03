import { describe, it, expect } from "vitest";
import { guarded, corsHeaders } from "./wallet-http";

const ORIGIN = "https://drevifashion.com";
const req = (method = "POST") => new Request("https://portal.test/api/wallet/redeem", { method, headers: { Origin: ORIGIN } });

describe("guarded wallet routes", () => {
  it("answers an unexpected error as JSON with CORS headers, never a bare 500", async () => {
    const h = guarded(async () => { throw new Error("Shopify: Title must be unique for automatic discount."); });
    const res = await h(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/try again/i);
    expect(JSON.stringify(body)).not.toMatch(/Shopify|unique/); // the cause stays in the log
  });
  it("passes a normal response straight through", async () => {
    const h = guarded(async (r) => new Response("ok", { headers: corsHeaders(r) }));
    const res = await h(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
  it("gives no CORS header to an origin that isn't ours", async () => {
    const h = guarded(async () => { throw new Error("x"); });
    const res = await h(new Request("https://portal.test/api/wallet/me", { headers: { Origin: "https://evil.example" } }));
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
