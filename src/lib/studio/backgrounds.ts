// Studio backgrounds (Ansh, 3 Sep) — grey stops being the only look.
//
// Each design carries ONE background style (designs.bg_style). 'auto' picks a
// preset deterministically from the design's identity, which answers the
// determinism worry: the "AI choosing" is a stable function of the design, so
// the front, back, side and every regeneration of the same outfit land on the
// SAME background — while different designs vary. Picking an explicit preset
// pins it completely.
//
// The prompt language borrows the premium-ecom look (kalkifashion-style):
// warm seamless paper, a subtle vertical gradient darker toward the floor,
// and a realistic soft contact shadow under the model/garment.

export interface BgPreset {
  key: string;
  label: string;
  /** Full background clause dropped into generation prompts. */
  prompt: string;
}

const SHADOW =
  "with a realistic soft contact shadow beneath the model and a gentle floor falloff — the shadow grounds the figure, nothing floats";

export const BG_PRESETS: BgPreset[] = [
  {
    key: "grey",
    label: "Studio Grey",
    prompt: `seamless neutral grey studio backdrop, soft even lighting, subtle vertical gradient slightly darker at the floor, no props, ${SHADOW}`,
  },
  {
    key: "ivory",
    label: "Warm Ivory",
    prompt: `seamless warm ivory studio backdrop, soft diffused lighting, subtle vertical gradient slightly darker at the floor, no props, ${SHADOW}`,
  },
  {
    key: "champagne",
    label: "Champagne",
    prompt: `seamless pale champagne-beige studio backdrop with a soft warm glow, subtle vignette toward the edges, premium fashion-catalogue feel, no props, ${SHADOW}`,
  },
  {
    key: "taupe",
    label: "Taupe",
    prompt: `seamless warm taupe studio backdrop, smooth vertical gradient from light at the top to deeper taupe at the floor, soft directional lighting, no props, ${SHADOW}`,
  },
  {
    key: "charcoal",
    label: "Charcoal",
    prompt: `seamless deep charcoal studio backdrop, soft rim lighting, subtle gradient with a faint spotlight pool on the floor, no props, ${SHADOW}`,
  },
];

export const AUTO_KEY = "auto";

/** Presets 'auto' may land on — charcoal stays an explicit choice only. */
const AUTO_POOL = ["ivory", "champagne", "taupe", "grey"] as const;

/** Small stable string hash (djb2) — no Math.random, same input same output. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Resolve a design's stored bg_style to a concrete preset. `seedKey` should be
 * stable for the design (base SKU + colour) so 'auto' is deterministic across
 * angles, regenerations and time.
 */
export function resolveBgPreset(bgStyle: string | null | undefined, seedKey: string): BgPreset {
  const style = (bgStyle ?? AUTO_KEY).trim().toLowerCase();
  if (style !== AUTO_KEY) {
    const hit = BG_PRESETS.find((p) => p.key === style);
    if (hit) return hit;
  }
  const pick = AUTO_POOL[hash(seedKey) % AUTO_POOL.length];
  return BG_PRESETS.find((p) => p.key === pick)!;
}
