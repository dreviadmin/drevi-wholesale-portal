/**
 * The buyer/staff password generator, for standalone scripts.
 *
 * Node cannot import the app's src/lib/password.ts, so this is a deliberate
 * copy. src/lib/password.test.ts asserts the two word lists stay identical —
 * if you edit one, that test fails until you edit the other.
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

export function generateMemorablePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(1000, 10000));
  return `${pick()}-${pick()}-${digits}`;
}

export { WORDS };
