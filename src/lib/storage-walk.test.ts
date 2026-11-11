import { describe, it, expect } from "vitest";
import { listAllObjectPaths, type StorageLister } from "./storage-walk";

// A fake bucket: object paths in, a Storage-shaped lister out (a folder is an
// entry with id null, exactly as Supabase reports it).
function fakeBucket(objects: string[], failing: string[] = []): StorageLister {
  return async (prefix) => {
    if (failing.includes(prefix)) return { data: null, error: { message: "boom" } };
    const seen = new Map<string, string | null>();
    for (const o of objects) {
      if (prefix && !o.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? o.slice(prefix.length + 1) : o;
      const [head, ...tail] = rest.split("/");
      seen.set(head, tail.length > 0 ? null : `id:${o}`);
    }
    return { data: [...seen].map(([name, id]) => ({ name, id })), error: null };
  };
}

describe("listAllObjectPaths", () => {
  it("finds note photos two folders deep (they were missing from the backup)", async () => {
    const objects = ["design/abc-123/1727-x1.jpg", "vendor/v-9/1727-y2.png", "root.jpg", "owner-1/card.jpg"];
    const { paths, warnings } = await listAllObjectPaths(fakeBucket(objects), "note-photos");
    expect(paths.sort()).toEqual([...objects].sort());
    expect(warnings).toEqual([]);
  });

  it("keeps the old root warning wording when the bucket cannot be listed", async () => {
    const { paths, warnings } = await listAllObjectPaths(fakeBucket(["a/b.jpg"], [""]), "receipt-photos");
    expect(paths).toEqual([]);
    expect(warnings).toEqual(["receipt-photos: list failed — boom"]);
  });

  it("warns on a folder it cannot list instead of skipping it silently", async () => {
    const { paths, warnings } = await listAllObjectPaths(fakeBucket(["ok/1.jpg", "bad/2.jpg"], ["bad"]), "custom-items");
    expect(paths).toEqual(["ok/1.jpg"]);
    expect(warnings).toEqual(["custom-items/bad/: list failed — boom"]);
  });

  it("stops at the depth guard with a warning", async () => {
    const { paths, warnings } = await listAllObjectPaths(fakeBucket(["a/b/c/deep.jpg", "a/shallow.jpg"]), "b", 2);
    expect(paths).toEqual(["a/shallow.jpg"]);
    expect(warnings).toEqual(["b/a/b/c/: more than 2 folders deep — skipped"]);
  });
});
