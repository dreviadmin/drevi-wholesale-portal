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
