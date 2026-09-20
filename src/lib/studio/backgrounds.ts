// Studio backgrounds (Ansh, 19 Sep) — THREE modes, one stored column.
//
// Replaces the 3-Sep "five prose presets" model. That version described a
// backdrop in words and hoped the edit model would paint it; a 26-render bench
// showed the words were the weak link — the same sentence produced a different
// wall on every run, and "premium ecom" prose talked the model into re-lighting
// the garment. What actually holds is either (a) say almost nothing and let the
// model clean up, or (b) SHOW it the backdrop as a second image. Hence:
//
//   minimal   Minimal — white. Prompt only, no plate. The recommended look and
//             the new default: the shortest prompt won the bench outright.
//   grey      Studio grey. Prompt only, no plate. The wording the studio has
//             been shipping since 3 Sep, kept verbatim so anything already
//             approved under it can be reproduced.
//   coloured  A PLATE IMAGE is sent alongside the garment photo. Five Kalki-
//             derived backdrops (ivory/sand/stone/blush/midnight), plus 'auto'.
//
// designs.bg_style stores ONE of eight values: 'minimal' | 'grey' | 'auto' |
// the five colour keys. 'auto' is the only one that needs resolving, and it
// resolves deterministically from the design's seed key (base SKU + colour) —
// the same djb2 hash and the same contract as the 3-Sep resolveBgPreset, just
// over the five colour keys. That is what answers the determinism worry: the
// front, back, side and every regeneration of one outfit land on the SAME
// backdrop, while different designs vary.
//
// PURE MODULE — no server-only, no supabase, no fs imports. prompts.ts, its
// vitest suite and the client Workbench all import it. The plate's storage
// PATH lives here; turning that path into a URL is the server's job
// (supabase storage getPublicUrl), because Vercel does not trace assets/.

export type BgMode = "minimal" | "grey" | "coloured";

/** The five plate-backed colours. Order is the UI's chip order. */
export type BgColourKey = "ivory" | "sand" | "stone" | "blush" | "midnight";

/** Every legal designs.bg_style value (0053 puts the same list in a CHECK). */
export type BgStyle = "minimal" | "grey" | "auto" | BgColourKey;

export const AUTO_KEY = "auto";

/** What a design gets when nobody has chosen — "recommended" in the UI. */
export const DEFAULT_BG_STYLE: BgStyle = "minimal";

/**
 * The two colours a backdrop actually shows: the wall behind the model and the
 * floor she stands on. Rendered as a small dot beside the chip so Grishma can
 * see which backdrop suits an outfit instead of decoding five nouns
 * (Ansh, 20 Sep).
 */
export interface BgSwatch {
  wall: string;
  floor: string;
}

export interface BgColour {
  key: BgColourKey;
  /** UI chip text. */
  label: string;
  /**
   * SAMPLED FROM THE PLATE ITSELF (assets/backgrounds/<key>.jpg), not picked
   * by eye: wall = mean of the 12–38% band, floor = mean of the 88–98% band.
   * So the dot cannot drift from what the model is actually handed — if a
   * plate is ever re-cut, re-sample rather than nudging these by hand.
   */
  swatch: BgSwatch;
  /**
   * Prose description of this plate. NOT used for the coloured-mode prompt —
   * that one just says "use the attached background" — but needed by the two
   * paths that cannot carry an image: the legacy model-swap photo brief, and
   * the OpenAI fallback for an API shape that refuses a second image part.
   */
  prompt: string;
}

// Every clause ends with the same shadow sentence: an un-grounded cut-out is
// the single most obvious "this was AI'd" tell in a catalogue grid.
const SHADOW =
  "with a realistic soft contact shadow beneath the model and a gentle floor falloff — the shadow grounds the figure, nothing floats";

/** The five plates, described as they actually look (wall + floor, not a flat swatch). */
export const BG_COLOURS: readonly BgColour[] = [
  {
    key: "ivory",
    label: "Ivory",
    swatch: { wall: "#f0e5cb", floor: "#ece1c7" },
    prompt: `seamless warm ivory studio wall meeting a pale stone floor, soft diffused lighting, no props, ${SHADOW}`,
  },
  {
    key: "sand",
    label: "Sand",
    swatch: { wall: "#d0ab93", floor: "#cca891" },
    prompt: `seamless warm sand-terracotta studio wall meeting a matching sand floor, soft directional lighting, no props, ${SHADOW}`,
  },
  {
    key: "stone",
    label: "Stone",
    swatch: { wall: "#b2b1b7", floor: "#aeadb3" },
    prompt: `seamless cool grey-blue stone studio wall meeting a polished grey floor, soft even lighting, no props, ${SHADOW}`,
  },
  {
    key: "blush",
    label: "Blush",
    swatch: { wall: "#d4b1b5", floor: "#d0aeb2" },
    prompt: `seamless soft blush-pink studio wall meeting a pale pink floor, soft diffused lighting, no props, ${SHADOW}`,
  },
  {
    key: "midnight",
    label: "Midnight",
    swatch: { wall: "#3c3754", floor: "#3b3752" },
    prompt: `seamless deep midnight-indigo studio wall meeting a dark reflective floor, soft rim lighting, no props, ${SHADOW}`,
  },
] as const;

/** The grey clause, byte-for-byte what 3 Sep shipped — see the header. */
const GREY_PROMPT = `seamless neutral grey studio backdrop, soft even lighting, subtle vertical gradient slightly darker at the floor, no props, ${SHADOW}`;

/** Minimal has no plate; this clause exists only for the prose-only paths. */
const MINIMAL_PROMPT = `seamless pure white studio backdrop, soft even lighting, no props, ${SHADOW}`;

/**
 * Minimal and grey have NO plate to sample — they are described to the model in
 * words — so these two are representative rather than measured: white, and the
 * neutral grey with the slightly darker floor that GREY_PROMPT asks for.
 */
export const BG_MODE_SWATCH: Record<BgMode, BgSwatch | null> = {
  minimal: { wall: "#ffffff", floor: "#f4f2ee" },
  grey: { wall: "#c9c9c9", floor: "#bcbcbc" },
  // Coloured has no single colour of its own — the chip row below it shows the
  // five, and the resolved one is what the UI dots against Auto.
  coloured: null,
};

export const BG_MODE_LABEL: Record<BgMode, string> = {
  minimal: "Minimal · white",
  grey: "Studio grey",
  coloured: "Coloured",
};

/**
 * The stored value each mode button writes. Coloured lands on 'auto' so a
 * first click still produces a deterministic pick rather than an empty state.
 */
export const BG_MODE_DEFAULT: Record<BgMode, BgStyle> = {
  minimal: "minimal",
  grey: "grey",
  coloured: AUTO_KEY,
};

export const BG_STYLES: readonly BgStyle[] = [
  "minimal",
  "grey",
  AUTO_KEY,
  ...BG_COLOURS.map((c) => c.key),
] as const;

export function isBgStyle(value: string): value is BgStyle {
  return (BG_STYLES as readonly string[]).includes(value);
}

/** The plates live in the EXISTING public `product-images` bucket. */
export const BG_PLATE_BUCKET = "product-images";

/** Storage path of a plate — mirrors the PWA-icon convention: built once, served forever. */
export function platePathFor(key: BgColourKey): string {
  return `_backgrounds/${key}.jpg`;
}

export interface ResolvedBackground {
  /** The normalised stored value (unknown input falls back to the default). */
  stored: BgStyle;
  mode: BgMode;
  /** Which plate — set in coloured mode only, with 'auto' already resolved. */
  colourKey: BgColourKey | null;
  /** One line for the UI: "Minimal — white", "Studio grey", "Sand", … */
  label: string;
  /** Where the plate lives in BG_PLATE_BUCKET; null outside coloured mode. */
  platePath: string | null;
  /** Prose clause — see BgColour.prompt for why a plate still carries words. */
  prompt: string;
  /** Wall/floor colours for the UI dot — the plate's own in coloured mode. */
  swatch: BgSwatch;
}

/** Small stable string hash (djb2) — no Math.random, same input same output. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Resolve a design's stored bg_style to a mode, a plate and a label.
 *
 * `seedKey` should be stable for the design (base SKU + colour) so 'auto' is
 * deterministic across angles, regenerations and time — the 3-Sep contract,
 * unchanged. Unknown or empty input resolves to the DEFAULT (minimal), which
 * is the deliberate behaviour change 0053 documents.
 */
export function resolveBackground(
  bgStyle: string | null | undefined,
  seedKey: string,
): ResolvedBackground {
  const raw = (bgStyle ?? "").trim().toLowerCase();
  const stored: BgStyle = isBgStyle(raw) ? raw : DEFAULT_BG_STYLE;

  if (stored === "minimal") {
    return { stored, mode: "minimal", colourKey: null, label: "Minimal — white", platePath: null, prompt: MINIMAL_PROMPT, swatch: BG_MODE_SWATCH.minimal! };
  }
  if (stored === "grey") {
    return { stored, mode: "grey", colourKey: null, label: BG_MODE_LABEL.grey, platePath: null, prompt: GREY_PROMPT, swatch: BG_MODE_SWATCH.grey! };
  }

  const colourKey: BgColourKey =
    stored === AUTO_KEY ? BG_COLOURS[hash(seedKey) % BG_COLOURS.length].key : stored;
  const colour = BG_COLOURS.find((c) => c.key === colourKey)!;
  return {
    stored,
    mode: "coloured",
    colourKey,
    label: colour.label,
    platePath: platePathFor(colourKey),
    prompt: colour.prompt,
    swatch: colour.swatch,
  };
}
