/**
 * The buyer/staff password generator, for standalone scripts.
 *
 * Node cannot import the app's src/lib/password.ts, so this is a deliberate
 * copy. src/lib/password.test.ts asserts the two word lists stay identical and
 * that buyerPasswordStem() gives the same answer here as there — if you edit
 * one, that test fails until you edit the other.
 */
import crypto from "node:crypto";

const WORDS = [
  "Tulip", "Lotus", "Jasmine", "Marigold", "Saffron", "Indigo", "Amber", "Coral",
  "Maroon", "Ivory", "Crimson", "Emerald", "Champagne", "Velvet", "Silk", "Brocade",
  "Mirror", "Pearl", "Mango", "Peacock", "Lantern", "Monsoon", "Henna", "Paisley",
  "Garnet", "Topaz", "Lilac", "Cobalt", "Bronze", "Copper", "Mauve", "Sage",
  "Cedar", "Willow", "Orchid", "Dahlia", "Poppy", "Iris", "Wren", "Heron",
  "River", "Meadow", "Harbor", "Summit", "Canyon", "Aurora", "Comet", "Zephyr",
  "Falcon", "Tiger", "Sparrow", "Otter", "Bamboo", "Cardamom", "Clove", "Nutmeg",
  "Verbena", "Linen", "Cotton", "Chiffon", "Organza", "Taffeta", "Damask", "Tweed",
];

/** Staff: Word-Word-4digits. */
export function generateMemorablePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(1000, 10000));
  return `${pick()}-${pick()}-${digits}`;
}

const HONORIFICS = new Set(["mr", "mrs", "ms", "mx", "dr", "shri", "smt", "sri"]);

/**
 * Buyers: owner's first name (else the business's first word) + three digits,
 * e.g. `rakhi482`. Mirrors src/lib/password.ts exactly — read the rationale
 * there. Stems shorter than three letters pull in the next words so the
 * password always clears GoTrue's six-character minimum.
 */
export function buyerPasswordStem(ownerName, businessName) {
  const wordsOf = (s) => {
    const all = (s ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    const named = all.filter((w) => !HONORIFICS.has(w));
    return named.length ? named : all;
  };
  const owner = wordsOf(ownerName);
  const words = owner.length ? owner : wordsOf(businessName);
  let stem = "";
  for (const w of words) {
    if (stem.length >= 3) break;
    stem += w;
  }
  return stem || "drevi";
}

export function generateBuyerPassword(ownerName, businessName) {
  return `${buyerPasswordStem(ownerName, businessName)}${crypto.randomInt(100, 1000)}`;
}

export { WORDS };
