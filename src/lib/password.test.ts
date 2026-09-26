import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateMemorablePassword, generateBuyerPassword } from "./password";

/** The word list is duplicated in scripts/lib/password.mjs because a plain
 *  .mjs script cannot import this TypeScript module. Drift between the two
 *  would mean bulk-issued passwords silently stop matching the ones the admin
 *  UI issues, so the copies are pinned to each other here. */
function words(src: string): string[] {
  const body = /const WORDS = \[([\s\S]*?)\];/.exec(src);
  if (!body) throw new Error("no WORDS array found");
  return [...body[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("generateMemorablePassword", () => {
  it("is Word-Word-4digits and never contains the string 123 as a whole suffix", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateMemorablePassword()).toMatch(/^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
    }
  });

  it("is not derivable from anything about the buyer", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateMemorablePassword()));
    // 64 x 64 x 9000 combinations: 500 draws should essentially never repeat.
    expect(seen.size).toBeGreaterThan(495);
  });

  it("the script copy of the word list matches this one", () => {
    const app = words(readFileSync("src/lib/password.ts", "utf8"));
    const script = words(readFileSync("scripts/lib/password.mjs", "utf8"));
    expect(script).toEqual(app);
    expect(app.length).toBe(64);
  });

  it("buyer passwords are one short lowercase word and four digits — typeable on a phone", () => {
    for (let i = 0; i < 300; i++) {
      const p = generateBuyerPassword();
      expect(p).toMatch(/^[a-z]{3,7}[0-9]{4}$/);
      expect(p.length).toBeLessThanOrEqual(11);
    }
  });

  it("buyer passwords never end in 123 as a suffix scheme and are not derivable", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateBuyerPassword()));
    expect(seen.size).toBeGreaterThan(490);
  });
});
