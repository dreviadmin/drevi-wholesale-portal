import type { Angle } from "./state";

// Retrofit R5 (§7.1) — uniform grey studio processing.
//
// There is NO tier branching anywhere in the photo pipeline, no scene
// composition and no per-design background choice. Every processed angle lands
// on the same neutral grey studio background; angles differ only in framing.
// `tier` survives solely as a copy-model hint (§8).

export const STUDIO_BACKGROUND =
  "seamless neutral grey studio background, soft even lighting, no props, no scene, no floor line";

// `lifestyle` is a SLOT, not a scene (§7.1): it keeps its name and its place in
// the set of six so composed backgrounds can arrive later without a migration,
// but today it is processed exactly like the other model angles.
const FRAMING: Record<string, string> = {
  front: "full-length front view, garment facing the camera, centred, head to hem in frame",
  back: "full-length back view, garment facing away from the camera, centred",
  side: "full-length three-quarter side view, centred",
  lifestyle: "full-length relaxed pose, natural stance, slightly off-centre — same grey studio, only the framing differs",
};

export interface PromptDesign {
  title?: string | null;
  category?: string | null;
  subCategory?: string | null;
  color?: string | null;
  fabric?: string | null;
  handwork?: string | null;
}

/** The garment, described from the design's own specs — never invented. */
export function garmentPhrase(d: PromptDesign): string {
  const bits = [
    d.color?.trim(),
    d.fabric?.trim(),
    (d.subCategory || d.category)?.trim(),
  ].filter(Boolean);
  const base = bits.length ? bits.join(" ") : "the garment in the source photo";
  return d.handwork?.trim() ? `${base} with ${d.handwork.trim()}` : base;
}

/**
 * Default prompt for an angle, pre-filled from the design's specs. Saved
 * prompts always win — editing one sets prompt_edited_by_human so nothing
 * regenerates over it.
 */
export function defaultAnglePrompt(angle: Angle | string, engine: string | null, d: PromptDesign): string {
  // Detail angles are macro shots and are never processed (§7.1).
  if (String(angle).startsWith("detail")) return "";

  const garment = garmentPhrase(d);

  // openai_bg means "normalise the background to neutral grey" — the useful job
  // when a garment is shot on a mannequin against shop clutter. It is a
  // background normalisation, NOT a scene.
  if (engine === "openai_bg") {
    return [
      `Replace the background of this photo with a ${STUDIO_BACKGROUND}.`,
      `Keep ${garment} exactly as photographed — same colour, drape, folds, embroidery and every detail.`,
      "Do not restyle, re-pose, re-light or re-synthesise the garment. Background only.",
    ].join(" ");
  }

  const framing = FRAMING[String(angle)] ?? FRAMING.front;
  return [
    `Studio product photograph of ${garment}, worn on a model.`,
    `${framing.charAt(0).toUpperCase()}${framing.slice(1)}.`,
    `${STUDIO_BACKGROUND.charAt(0).toUpperCase()}${STUDIO_BACKGROUND.slice(1)}.`,
    "Preserve the garment's colour, fabric texture, drape and handwork exactly as in the source.",
  ].join(" ");
}
