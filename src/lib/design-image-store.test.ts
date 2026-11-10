import { beforeEach, describe, expect, it, vi } from "vitest";
import { REAL_REFS, TRAVERSAL_REFS } from "./image-ref-core.fixtures";

// fetchImageByRef downloads with the service-role client. Here that client is
// a REAL supabase-js client whose fetch is a recorder, so "Storage was never
// called" means no request of any kind left the process, and the request a
// good ref makes is the one storage-js really builds.
const h = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; apikey: string | null }>,
  drive: vi.fn(async () => ({ body: new ArrayBuffer(3), contentType: "image/jpeg" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    createAdminClient: () =>
      createClient("https://stub.supabase.co", "service-role-test-key", {
        auth: { persistSession: false },
        global: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            h.requests.push({ url: req.url, apikey: req.headers.get("apikey") });
            return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), { status: 200 });
          },
        },
      }),
  };
});
vi.mock("@/lib/drive", () => ({ fetchDriveImage: h.drive }));
vi.mock("@/lib/design-imagery", () => ({ ensureDesignImagery: vi.fn() }));
vi.mock("@/lib/drive-design", () => ({
  uploadsEnabled: () => false,
  ensureDesignFolder: vi.fn(),
  listFolderImages: vi.fn(),
  nextFileName: vi.fn(),
  uploadDesignImage: vi.fn(),
  archiveFile: vi.fn(),
}));
// The route, as an ordinary signed-in staff member.
vi.mock("@/lib/staff", () => ({ getStaff: async () => ({ id: "staff-test", role: "staff" }) }));
// vitest has no "@/" alias here; point the route's imports at the real modules.
vi.mock("@/lib/design-image-store", async () => await import("./design-image-store"));
vi.mock("@/lib/attachment-name", async () => await import("./attachment-name"));

import { fetchImageByRef } from "./design-image-store";
import { GET } from "../app/api/drive-photo/route";

beforeEach(() => {
  h.requests.length = 0;
  h.drive.mockClear();
});

describe("fetchImageByRef refuses traversal before Storage is called", () => {
  it.each(TRAVERSAL_REFS)("%j", async (ref) => {
    expect(await fetchImageByRef(ref)).toBeNull();
    expect(h.requests).toEqual([]);
    expect(h.drive).not.toHaveBeenCalled();
  });
});

describe("fetchImageByRef still serves real refs", () => {
  it.each(REAL_REFS)("%s", async (ref, bucket, path) => {
    const img = await fetchImageByRef(ref);
    expect(img).not.toBeNull();
    expect(img!.body.byteLength).toBe(3);
    expect(img!.contentType).toBe(path.endsWith(".png") ? "image/png" : "image/jpeg");
    expect(h.requests).toHaveLength(1);
    expect(new URL(h.requests[0].url).pathname).toBe(`/storage/v1/object/${bucket}/${path}`);
  });

  it("hands Drive ids to Drive untouched", async () => {
    await fetchImageByRef("1AbCdEfGhIjKlMnOpQrStUvWxYz_0123-", 500);
    expect(h.drive).toHaveBeenCalledWith("1AbCdEfGhIjKlMnOpQrStUvWxYz_0123-", 500);
    expect(h.requests).toEqual([]);
  });
});

// The same, end to end through the route, with the query strings that must be
// refused: plain, fully percent-encoded, and double-encoded so one layer
// survives searchParams decoding.
describe("/api/drive-photo", () => {
  const call = (query: string) => GET(new Request(`https://portal.test/api/drive-photo?${query}`));

  it.each([
    "id=sb:../../../../auth/v1/admin/users",
    "id=sb%3A..%2F..%2F..%2F..%2Frest%2Fv1%2Fstaff_users%3Fselect%3Demail%2Crole",
    "id=sb:../../../../rest/v1/shopify_tokens%3Fselect%3Daccess_token",
    "id=sb:../buyer-cards/BUYER/card.jpg&dl=1",
    "id=sb:%252e%252e/%252e%252e/%252e%252e/%252e%252e/rest/v1/buyers",
    "id=sb:.%252E/buyer-cards/BUYER/card.jpg",
    "id=sb:vendor-photos:..%2F..",
    "id=sb:vendor-photos:%252e%252e/%252e%252e/auth/v1/admin/users",
    "id=sb:..%5Cbuyer-cards%5CBUYER%5Ccard.jpg",
  ])("404s %s without any upstream request", async (query) => {
    const res = await call(query);
    expect(res.status).toBe(404);
    expect(h.requests).toEqual([]);
  });

  it("serves a real photo", async () => {
    const [ref, bucket, path] = REAL_REFS[0];
    const res = await call(`id=${encodeURIComponent(ref)}&s=500`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(3);
    expect(new URL(h.requests[0].url).pathname).toBe(`/storage/v1/object/${bucket}/${path}`);
  });

  // Composes with the route's raster-only headers (Studio review, 28b1cf6):
  // an accepted ref still goes out sandboxed and nosniff, and dl=1 still saves
  // the original under a generic name when no design_images row names it.
  it("downloads a real photo with dl=1 and keeps the sandbox headers", async () => {
    const [ref, bucket, path] = REAL_REFS[4]; // a vendor card (png), not a design photo
    const res = await call(`id=${encodeURIComponent(ref)}&dl=1&s=150`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="drevi-photo\.png"/);
    expect(new URL(h.requests[0].url).pathname).toBe(`/storage/v1/object/${bucket}/${path}`);
  });
});
