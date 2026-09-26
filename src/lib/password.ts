import crypto from "node:crypto";

// Memorable password generator for STAFF: {Word}-{Word}-{4digits} (spec §6.4).
// Words from a curated, pronounceable list; ~12+ chars with solid entropy.
// Server-side use.
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

export function generateMemorablePassword(): string {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(1000, 10000));
  return `${pick()}-${pick()}-${digits}`;
}

// Courtesy titles that sometimes lead an owner's name on a visiting card.
// Dropped so "Mr. Rakesh" yields "rakesh", not "mrrakesh".
const HONORIFICS = new Set(["mr", "mrs", "ms", "mx", "dr", "shri", "smt", "sri"]);

/**
 * BUYER passwords: the owner's first name and three digits — `rakhi482`.
 *
 * Ansh, 26 Sep: "keep firstname + 3 numbers only. don't worry about security."
 * Two earlier schemes (Word-Word-4digits, then word+4digits) were judged too
 * long for a shop owner typing on a phone; a password built from a name the
 * buyer already knows is the one they will actually remember. The security
 * trade-off was raised and explicitly accepted — the GoTrue sign-in rate limit
 * is what stands between a guess and an account.
 *
 * The stem is the first word of the owner's name, falling back to the business
 * name when no owner is recorded (132 of 248 prod buyers on 26 Sep). Letters
 * only, lowercase, accents folded ("Réné" → "rene"). A first word shorter than
 * three letters pulls in the following words ("Om (Kolours)" → "omkolours",
 * "GJ4 Fashion" → "gjfashion") so the result always clears GoTrue's
 * six-character minimum; a buyer with no usable name at all gets "drevi".
 * Digits run 100–999 so the number always reads as three digits.
 *
 * Mirrored in scripts/lib/password.mjs; password.test.ts pins the two copies.
 * Staff keep generateMemorablePassword(): an admin login gets the long form.
 */
export function buyerPasswordStem(ownerName: string | null | undefined, businessName: string | null | undefined): string {
  const wordsOf = (s: string | null | undefined): string[] => {
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

export function generateBuyerPassword(ownerName: string | null | undefined, businessName: string | null | undefined): string {
  return `${buyerPasswordStem(ownerName, businessName)}${crypto.randomInt(100, 1000)}`;
}
