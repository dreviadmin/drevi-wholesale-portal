import type { Angle } from "./state";
import { resolveBgPreset } from "./backgrounds";

// Retrofit R5 (§7.1) — uniform studio processing, now with per-design
// backgrounds (Ansh, 3 Sep): the background clause comes from the design's
// bg_style (or a deterministic 'auto' pick — see backgrounds.ts), so every
// angle and every regeneration of one outfit shares one look. Detail angles
// may now be background-cleaned by the EDIT engines (Ansh, 3 Sep) — the
// prompt is macro-safe: embroidery is preserved pixel-for-pixel, never
// re-synthesised. Model swap (fashn) stays banned on details.

/** Legacy export — the grey preset's old wording, kept for saved prompts. */
export const STUDIO_BACKGROUND =
  "seamless neutral grey studio background, soft even lighting, no props, no scene, no floor line";

// `lifestyle` is a SLOT, not a scene (§7.1): it keeps its name and its place in
// the set of six so composed backgrounds can arrive later without a migration,
// but today it is processed exactly like the other model angles.
const FRAMING: Record<string, string> = {
  front: "full-length front view, garment facing the camera, centred, head to hem in frame",
  back: "full-length back view, garment facing away from the camera, centred",
  side: "full-length three-quarter side view, centred",
  lifestyle: "full-length relaxed pose, natural stance, slightly off-centre — same studio backdrop, only the framing differs",
};

export interface PromptDesign {
  title?: string | null;
  category?: string | null;
  subCategory?: string | null;
  color?: string | null;      // SKU colour code (PBL)
  colorName?: string | null;  // human colour ("Powder Blue") — preferred in prompts
  fabric?: string | null;
  handwork?: string | null;
  bgStyle?: string | null;    // designs.bg_style ('auto' or a preset key)
  /** Stable seed for the 'auto' background — base SKU + colour. */
  bgSeed?: string | null;
}

/** The garment, described from the design's own specs — never invented. */
export function garmentPhrase(d: PromptDesign): string {
  const bits = [
    (d.colorName || d.color)?.trim(),
    d.fabric?.trim(),
    (d.subCategory || d.category)?.trim(),
  ].filter(Boolean);
  const base = bits.length ? bits.join(" ") : "the garment in the source photo";
  return d.handwork?.trim() ? `${base} with ${d.handwork.trim()}` : base;
}

function backgroundClause(d: PromptDesign): string {
  return resolveBgPreset(d.bgStyle, d.bgSeed || `${d.title ?? ""}|${d.color ?? ""}`).prompt;
}

/**
 * Default prompt for an angle, pre-filled from the design's specs. Saved
 * prompts always win — editing one sets prompt_edited_by_human so nothing
 * regenerates over it.
 */
export function defaultAnglePrompt(angle: Angle | string, engine: string | null, d: PromptDesign): string {
  const background = backgroundClause(d);

  // Detail angles: background clean-up only, macro fidelity absolute.
  if (String(angle).startsWith("detail")) {
    if (engine === "openai_bg" || engine === "seedream") {
      return [
        `Replace the background of this close-up detail photograph with a ${background}.`,
        "This is a macro shot of fabric and embroidery: keep every thread, sequin, bead and stitch pixel-exact.",
        "Do not sharpen, smooth, recolour or re-synthesise any part of the garment. Background only.",
      ].join(" ");
    }
    return "";
  }

  const garment = garmentPhrase(d);

  // openai_bg and seedream are EDIT models: their job is "normalise the
  // background", not a re-shoot. The pipeline learned this the hard way —
  // photo-brief prompts made edit models redraw faces and embroidery
  // (image_providers.PROMPT_STRICT).
  if (engine === "openai_bg" || engine === "seedream") {
    return [
      `Replace the background of this photo with a ${background}.`,
      `Keep ${garment} exactly as photographed — same colour, drape, folds, embroidery and every detail.`,
      "Do not restyle, re-pose, re-light or re-synthesise the garment. Background only.",
    ].join(" ");
  }

  const framing = FRAMING[String(angle)] ?? FRAMING.front;
  return [
    `Studio product photograph of ${garment}, worn on a model.`,
    `${framing.charAt(0).toUpperCase()}${framing.slice(1)}.`,
    `${background.charAt(0).toUpperCase()}${background.slice(1)}.`,
    "Preserve the garment's colour, fabric texture, drape and handwork exactly as in the source.",
  ].join(" ");
}
