import crypto from "node:crypto";

// Memorable password generator: {Word}-{Word}-{4digits} (spec §6.4). Words from
// a curated, pronounceable list; ~12+ chars with solid entropy. Server-side use.
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

/**
 * BUYER passwords: one word and four digits, all lowercase — `lotus4821`.
 *
 * Ansh, 26 Sep: the Word-Word-4digits form was too long for a shop owner on a
 * phone keyboard. This is nine or ten characters with no shift key, still not
 * derivable from anything about the shop (the old <username>xdrevi was), and
 * a ~550,000-way space that the sign-in rate limit makes impractical to guess.
 * Words over seven letters are skipped so "champagne" never lands on someone.
 *
 * Staff keep generateMemorablePassword(): an admin login gets the long form.
 */
export function generateBuyerPassword(): string {
  const short = WORDS.filter((w) => w.length <= 7);
  const word = short[crypto.randomInt(short.length)].toLowerCase();
  return `${word}${crypto.randomInt(1000, 10000)}`;
}

