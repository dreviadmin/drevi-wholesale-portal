import type { Angle } from "./state";
import { resolveBackground } from "./backgrounds";

// Angle prompts — now MODE-AWARE (Ansh, 19 Sep).
//
// The wordings below came out of a 26-render bench and are the owner's own
// words. Do not embellish them. The bench's finding, in one line: for an edit
// model, a long "premium studio photography" brief is not instruction, it is
// permission — the more scene you describe, the more freely it re-lights,
// re-crops and re-draws the garment. The prompts that survived are the short
// ones.
//
//   minimal   "make this retail website ready: color correction and background
//             change" — nothing else. Recommended, and the default.
//   coloured  the same line plus "Use the attached background." The backdrop
//             arrives as a second IMAGE (see engines.ts); the prompt only has
//             to point at it.
//   grey      unchanged from 3 Sep: the long Replace-the-background sentence
//             that names the garment and ends "Background only." Kept verbatim
//             so anything approved under it can be reproduced.
//
// The matte engine (20 Sep) sits outside all three: it composites the source
// pixels onto a ground it draws itself and never sends a prompt anywhere, so
// defaultAnglePrompt returns '' for it. The guard at the top of the function
// is that contract.
//
// Saved prompts always win — editing one sets prompt_edited_by_human so
// nothing regenerates over it.

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
  bgStyle?: string | null;    // designs.bg_style — one of the eight legal values
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

function background(d: PromptDesign) {
  return resolveBackground(d.bgStyle, d.bgSeed || `${d.title ?? ""}|${d.color ?? ""}`);
}

/** The whole minimal prompt. Yes, this is the entire thing — that is the point. */
const MINIMAL_LINE = "make this retail website ready: color correction and background change";

/** Minimal + one sentence pointing at the plate the engine attaches. */
const COLOURED_LINE = `${MINIMAL_LINE}. Use the attached background.`;

/** True for 'detail_1' / 'detail_2' — the macro close-ups. */
function isDetailAngle(angle: Angle | string): boolean {
  return String(angle).startsWith("detail");
}

/**
 * Default prompt for an angle, pre-filled from the design's specs.
 */
export function defaultAnglePrompt(angle: Angle | string, engine: string | null, d: PromptDesign): string {
  const bg = background(d);
  const isDetail = isDetailAngle(angle);

  // ── matte: no model is being instructed, so there is no prompt ───────────
  // This returns '' DELIBERATELY, and it is tested FIRST so the engine can
  // never reach either branch below. Falling through to the model-swap brief
  // is the exact failure the review caught on nano_banana the same day (an
  // empty string on a detail angle, "worn on a model" on the rest), and on
  // matte it would be silent: nothing reads matte's params.prompt, so a wrong
  // prompt would simply sit in the job row and in the operator's prompt box
  // describing work the engine does not do. The Workbench hides that box for
  // matte the way it already does for 'raw', so the empty string is never
  // shown either.
  if (engine === "matte") return "";

  const isEditEngine = engine === "openai_bg" || engine === "seedream" || engine === "nano_banana";

  // ── The selectable edit engines: openai_bg, seedream, nano_banana ───────
  // Miss one out of this test and its angles fall through to the PARKED
  // model-swap brief below — an empty string on a detail angle, and
  // "worn on a model" on the rest, i.e. the engine is asked to synthesise
  // a person instead of replacing a wall. Adding an engine means adding it
  // here too (20 Sep, caught in review before nano_banana shipped).
  if (isEditEngine) {
    const mode = bg.mode;
    if (mode === "minimal") return MINIMAL_LINE;
    if (mode === "coloured") return COLOURED_LINE;

    // grey — 3 Sep's wording, unchanged. Detail keeps its macro-fidelity
    // clause because this prompt is long enough to need one.
    if (isDetail) {
      return [
        `Replace the background of this close-up detail photograph with a ${bg.prompt}.`,
        "This is a macro shot of fabric and embroidery: keep every thread, sequin, bead and stitch pixel-exact.",
        "Do not sharpen, smooth, recolour or re-synthesise any part of the garment. Background only.",
      ].join(" ");
    }
    return [
      `Replace the background of this photo with a ${bg.prompt}.`,
      `Keep ${garmentPhrase(d)} exactly as photographed — same colour, drape, folds, embroidery and every detail.`,
      "Do not restyle, re-pose, re-light or re-synthesise the garment. Background only.",
    ].join(" ");
  }

  // ── Everything else: 'raw', and the parked 'fashn' model-swap ────────────
  // fashn is no longer selectable (FASHN_ENABLED, default off) but its code
  // path is intact, so its photo-brief prompt stays intact too — a re-enabled
  // engine that silently generated a different prompt would be worse than a
  // dead one. Model swap still never runs on a detail shot.
  if (isDetail) return "";

  const framing = FRAMING[String(angle)] ?? FRAMING.front;
  return [
    `Studio product photograph of ${garmentPhrase(d)}, worn on a model.`,
    `${framing.charAt(0).toUpperCase()}${framing.slice(1)}.`,
    `${bg.prompt.charAt(0).toUpperCase()}${bg.prompt.slice(1)}.`,
    "Preserve the garment's colour, fabric texture, drape and handwork exactly as in the source.",
  ].join(" ");
}
