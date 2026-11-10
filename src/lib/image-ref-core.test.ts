import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { isSafeObjectPath, parseStorageRef } from "./image-ref-core";
import { MALFORMED_REFS, REAL_REFS, TRAVERSAL_REFS } from "./image-ref-core.fixtures";

describe("parseStorageRef", () => {
  it.each(TRAVERSAL_REFS)("refuses traversal form %j", (ref) => {
    expect(parseStorageRef(ref)).toBeNull();
  });

  it.each(MALFORMED_REFS)("refuses malformed ref %j", (ref) => {
    expect(parseStorageRef(ref)).toBeNull();
  });

  it.each(REAL_REFS)("keeps serving %s", (ref, bucket, path) => {
    expect(parseStorageRef(ref)).toEqual({ bucket, path });
  });

  it("is not a storage ref without the prefix (Drive ids go elsewhere)", () => {
    expect(parseStorageRef("1AbCdEfGhIjKlMnOpQrStUvWxYz_0123-")).toBeNull();
  });

  it("allows dots inside a name, just never a whole dot segment", () => {
    expect(isSafeObjectPath("a/b.c.jpg")).toBe(true);
    expect(isSafeObjectPath("a/...jpg")).toBe(true);
    expect(isSafeObjectPath("a/../b.jpg")).toBe(false);
  });
});

// The property the allow-list exists for, checked against the real client
// rather than a model of it: whatever path is accepted, the request storage-js
// actually sends stays inside /storage/v1/object/<bucket>/.
describe("an accepted path cannot leave its bucket", () => {
  async function sentUrl(bucket: string, path: string): Promise<URL> {
    let seen: string | null = null;
    const client = createClient("https://stub.supabase.co", "service-role-test-key", {
      auth: { persistSession: false },
      global: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          seen = new Request(input, init).url;
          return new Response(new Blob(["x"]));
        },
      },
    });
    await client.storage.from(bucket).download(path);
    if (!seen) throw new Error("no request was sent");
    return new URL(seen);
  }

  it.each(REAL_REFS)("%s", async (ref) => {
    const parsed = parseStorageRef(ref)!;
    const url = await sentUrl(parsed.bucket, parsed.path);
    expect(url.origin).toBe("https://stub.supabase.co");
    expect(url.pathname).toBe(`/storage/v1/object/${parsed.bucket}/${parsed.path}`);
    expect(url.search).toBe("");
  });
});
