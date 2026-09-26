import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateMemorablePassword, generateBuyerPassword, buyerPasswordStem } from "./password";

/** The generator is duplicated in scripts/lib/password.mjs because a plain
 *  .mjs script cannot import this TypeScript module. Drift between the two
 *  would mean bulk-issued passwords silently stop matching the ones the admin
 *  UI issues, so the copies are pinned to each other here. */
function words(src: string): string[] {
  const body = /const WORDS = \[([\s\S]*?)\];/.exec(src);
  if (!body) throw new Error("no WORDS array found");
  return [...body[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// Real shapes from the prod buyer list (26 Sep) plus the awkward ones.
const NAMES: [string | null, string | null][] = [
  ["Aarti B", "Aaroham by Aarti"],
  ["Pratik Shah", "Aishwarya Fashion Couture / Aishwarya Lifestyle Pvt. Ltd."],
  ["RAKHI KAPOOR", "AMARRA"],
  [null, "Abhishek - Anupam"],
  [null, "GJ4 Fashion"],
  [null, "Om (Kolours)"],
  [null, "OM TEX"],
  ["Mr. Umang Chopra", "Alisia Fabric-O-Land"],
  ["Réné D'Souza", "Boutique"],
  ["", ""],
  [null, null],
  ["  ", "123 456"],
];

describe("generateMemorablePassword (staff)", () => {
  it("is Word-Word-4digits", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateMemorablePassword()).toMatch(/^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/);
    }
  });

  it("is not derivable from anything about the person", () => {
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
});

describe("buyer passwords: first name + three digits (Ansh, 26 Sep)", () => {
  it("stem is the owner's first name, else the business's first word, letters only", () => {
    expect(buyerPasswordStem("Aarti B", "Aaroham by Aarti")).toBe("aarti");
    expect(buyerPasswordStem("RAKHI KAPOOR", "AMARRA")).toBe("rakhi");
    expect(buyerPasswordStem(null, "Abhishek - Anupam")).toBe("abhishek");
    expect(buyerPasswordStem("Mr. Umang Chopra", "Alisia")).toBe("umang");
    expect(buyerPasswordStem("Réné D'Souza", "Boutique")).toBe("rene");
  });

  it("a first word under three letters pulls in the next so GoTrue's 6-char floor is always met", () => {
    expect(buyerPasswordStem(null, "GJ4 Fashion")).toBe("gjfashion");
    expect(buyerPasswordStem(null, "Om (Kolours)")).toBe("omkolours");
    expect(buyerPasswordStem(null, "OM TEX")).toBe("omtex");
    expect(buyerPasswordStem("", "")).toBe("drevi");
    expect(buyerPasswordStem(null, "123 456")).toBe("drevi");
    for (const [o, b] of NAMES) expect(generateBuyerPassword(o, b).length).toBeGreaterThanOrEqual(6);
  });

  it("is <stem><three digits>, and the digits never start with 0", () => {
    for (let i = 0; i < 300; i++) {
      expect(generateBuyerPassword("Rakhi Kapoor", "Amarra")).toMatch(/^rakhi[1-9][0-9]{2}$/);
    }
  });

  it("the script copy produces the same stems and the same shape", async () => {
    const mod = await import(/* @vite-ignore */ pathToFileURL(resolve("scripts/lib/password.mjs")).href);
    for (const [o, b] of NAMES) expect(mod.buyerPasswordStem(o, b)).toBe(buyerPasswordStem(o, b));
    for (let i = 0; i < 50; i++) expect(mod.generateBuyerPassword("Rakhi", "Amarra")).toMatch(/^rakhi[1-9][0-9]{2}$/);
  });
});
