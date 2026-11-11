import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The middleware matcher decides which paths skip the auth gate entirely. It
// can't be imported here (middleware.ts uses the "@/" alias, which vitest does
// not have), so read the pattern out of the source — the house pattern for
// invariants between files, see buyer-gate.test.ts. A plain ^…$ RegExp is close
// enough to what Next compiles it into for these paths.
const src = fs.readFileSync(path.join(process.cwd(), "src/middleware.ts"), "utf8");
const literal = src.match(/matcher:\s*\[\s*("(?:[^"\\]|\\.)*")\s*\]/);
const gated = (pathname: string) => new RegExp(`^${JSON.parse(literal![1]) as string}$`).test(pathname);

describe("middleware matcher", () => {
  it("is found in the source", () => {
    expect(literal).not.toBeNull();
  });

  it("serves robots.txt without the gate (it 307'd to /login)", () => {
    expect(gated("/robots.txt")).toBe(false);
  });

  it("keeps the robots.txt exemption to that exact path", () => {
    for (const p of ["/robots.txt.bak", "/robots.txt/admin", "/robotsXtxt", "/robots"]) {
      expect(gated(p), p).toBe(true);
    }
  });

  it("still gates the pages", () => {
    for (const p of ["/catalog", "/admin", "/home", "/cart"]) expect(gated(p), p).toBe(true);
  });

  it("still lets the PWA files through", () => {
    for (const p of ["/sw.js", "/manifest.json"]) expect(gated(p), p).toBe(false);
  });
});
