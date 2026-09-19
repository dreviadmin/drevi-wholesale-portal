import "server-only";

import { fetchImageByRef } from "@/lib/design-image-store";
import { listFolderImages, listSubfolders } from "@/lib/drive";
import type { BgMode } from "@/lib/studio/backgrounds";

// UX sprint (29 Jul) — the three working generation engines, run in-process.
//
// Ported from pipeline/scripts/image_providers.py + 03_fashn_runner.py so the
// portal no longer depends on the parked hosted runner (ANSH-04):
//
//   fashn        FASHN model-swap — keeps the garment + pose from the source
//                photo, swaps identity to a brand-model reference. Async API:
//                submit /v1/run → poll /v1/status/<id>.
//                PARKED since 19 Sep — see fashnEnabled() below.
//   seedream     ByteDance Seedream edit via fal.ai. Synchronous.
//   nano_banana  Nano Banana 2 edit via fal.ai. Synchronous. Added 20 Sep.
//   openai       gpt-image-2 /v1/images/edits. Synchronous.
//   matte        NOT a generative engine. fal-ai/birefnet/v2 cuts the garment
//                out and src/lib/pipeline/matte.ts composites it onto a ground
//                built locally with sharp. Added 20 Sep.
//
// All of them accept the source photo as bytes and return image bytes; callers
// never learn which HTTP shape each provider speaks. Since 19 Sep the live
// ones also accept an optional coloured-background PLATE (see Plate) — a
// second image, sent after the garment, that shows the model the backdrop
// instead of describing it.
//
// 20 Sep, after a 38-render bench (Ansh): seedream moves from v4 to v5 Pro,
// and Nano Banana 2 joins it. The two are NOT interchangeable in one respect
// that the studio has to surface rather than hide — v5 Pro's content checker
// refuses part of this catalogue and Nano Banana does not. See refusalMessage.
//
// 20 Sep, later the same day: matte joins them, and it is a different KIND of
// engine rather than a fourth flavour of the same one. The three above hand a
// model the photograph and ask for a new photograph back; matte extracts an
// alpha channel and composites the ORIGINAL pixels onto a ground it draws
// itself. Invented handwork and colour drift are impossible by construction,
// and so is colour correction — see the Workbench hint, which says that out
// loud, and matte.ts, which does the pixel work.

const FASHN_BASE = "https://api.fashn.ai/v1";
// v5 Pro's endpoint id carries NO `fal-ai/` prefix — bytedance publishes this
// one under its own namespace. The prefix that every other fal model wants is
// a 404 here, so the two ids are written out rather than templated.
const FAL_SEEDREAM = "https://fal.run/bytedance/seedream/v5/pro/edit";
const FAL_NANO = "https://fal.run/fal-ai/nano-banana-2/edit";
// Background removal, not editing: this one returns the SAME photograph with a
// real alpha channel, which is the whole point of the matte engine.
const FAL_BIREFNET = "https://fal.run/fal-ai/birefnet/v2";

// Approx cost per output image, for the credits column (₹-agnostic units the
// studio already displays; matches image_providers.PRICE_PER_IMAGE). From
// fal's own listing, 20 Sep:
//
//   seedream (v5 Pro)  $0.0675 at or below 1536² (2,359,296 px), $0.135 above
//                      it. 0.0675 is the COMMON band, not a guaranteed one —
//                      seedreamSize asks for the source's own pixels, capped at
//                      DREVI_SEEDREAM_MAX_PX (4096), and the fetch bound is not
//                      the backstop it looks like:
//                        · fetchImageByRef ignores `size` for sb: storage refs
//                          (design-image-store.ts) — a phone capture arrives at
//                          its full 3024×4032 and bills $0.135;
//                        · fetchDriveImage falls back to alt:media, unbounded,
//                          whenever the =s1600 thumbnail fetch misses;
//                        · even bounded, 1600 caps the LONG edge — anything
//                          squarer than ~1600×1475 (a macro detail crop) is over
//                          1536² on its own.
//                      So a seedream render costs $0.0675 OR $0.135, and the
//                      figure below is the lower one. v4 was $0.03 — this change
//                      at least doubles the bill, and can quadruple it.
//   nano_banana        $0.08 at 1K, ×1.5 at 2K, ×2 at 4K. We default to 2K
//                      (see nanoResolution), so $0.12 is the honest number.
//   matte              $0.0023. MEASURED, not quoted: three birefnet calls off
//                      the fal balance before and after settled at $0.00222
//                      each. One segmentation call is the engine's whole spend
//                      — the compositing is local sharp — so unlike seedream
//                      this figure has no upper band. It is ~30x cheaper than
//                      seedream's floor and ~50x cheaper than Nano Banana.
//
// The Workbench estimate chips quote these same figures — if one moves, move
// both, because an estimate nobody trusts is worse than no estimate.
export const ENGINE_COST: Record<string, number> = { fashn: 2, seedream: 0.0675, nano_banana: 0.12, openai_bg: 0.22, matte: 0.0022 };

/** fal's own multipliers off Nano Banana's 1K base of $0.08. */
const NANO_RESOLUTION_COST: Record<string, number> = { "0.5K": 0.06, "1K": 0.08, "2K": 0.12, "4K": 0.16 };

/**
 * What one render of `engine` actually costs, now — not what the table says.
 *
 * ENGINE_COST is a flat lookup, which is a lie for Nano Banana the moment
 * DREVI_NANO_RESOLUTION moves off 2K: the render bills 0.75x to 2x the 1K base
 * and every cost_credits row would keep recording $0.12. The credits column is
 * the only spend record this app keeps, so it follows the env, not the table.
 */
export function engineCost(engine: string): number {
  if (engine === "nano_banana") return NANO_RESOLUTION_COST[nanoResolution()] ?? ENGINE_COST.nano_banana;
  return ENGINE_COST[engine] ?? 0;
}

export type EngineKind = "fashn" | "seedream" | "nano_banana" | "openai_bg" | "matte";

/**
 * engine ⇄ pipeline_jobs.type, in ONE place.
 *
 * This used to be two hand-kept ternaries facing each other — regenAngle's
 * engine → type, and the run route's TYPE_TO_ENGINE — and they drifted the
 * moment a fourth engine arrived: a nano_banana angle fell through
 * regenAngle's final `: "tryon"` and was queued as a try-on, which the route
 * then handed to the PARKED fashn provider. The operator's chip said Nano
 * Banana and the job died saying FASHN_ENABLED. A table both halves read
 * cannot drift like that.
 *
 * 'tryon' is fashn's historical type name and stays as-is: job rows on both
 * databases carry it, and renaming a stored enum value to tidy a map is not
 * worth a migration.
 */
export const ENGINE_JOB_TYPE: Record<EngineKind, string> = {
  fashn: "tryon",
  seedream: "seedream",
  nano_banana: "nano_banana",
  openai_bg: "openai_bg",
  matte: "matte",
};

/** The same table read backwards, derived so it cannot fall out of step. */
export const JOB_TYPE_ENGINE: Record<string, EngineKind> = Object.fromEntries(
  Object.entries(ENGINE_JOB_TYPE).map(([engine, type]) => [type, engine as EngineKind]),
);

/**
 * FASHN model-swap is PARKED (Ansh, 19 Sep: "disable fashn and RAW for now:
 * they are of no use currently"). The code below stays — the bench may want it
 * back, and deleting a working provider integration to express a product
 * decision is how integrations rot — but nothing may reach it unless this flag
 * is explicitly on. Same shape as SHOPIFY_ENABLED: a string 'true', default off.
 */
export function fashnEnabled(): boolean {
  return (process.env.FASHN_ENABLED ?? "").toLowerCase() === "true";
}

export function engineConfigured(engine: EngineKind): { ok: boolean; missing?: string } {
  // The flag is checked BEFORE the key, so a studio that still has a FASHN key
  // in its environment reports the engine as unavailable rather than offering
  // a button that the UI no longer draws.
  if (engine === "fashn" && !fashnEnabled()) return { ok: false, missing: "FASHN_ENABLED=true (model swap is parked)" };
  // seedream, nano_banana and matte are all fal models on the same account, so
  // one key lights all three chips — there is no separate Nano Banana or
  // birefnet credential. matte's compositing is local, but the cut-out it
  // composites is a fal call, so without FAL_KEY it has nothing to composite.
  const need =
    engine === "fashn" ? "FASHN_API_KEY" : engine === "openai_bg" ? "OPENAI_API_KEY" : "FAL_KEY";
  return process.env[need] ? { ok: true } : { ok: false, missing: need };
}

/**
 * A coloured-background plate (Ansh, 19 Sep) — the empty backdrop the engine
 * attaches ALONGSIDE the garment photo, resolved by the caller through
 * supabase storage getPublicUrl. `promptFallback` is the same backdrop said in
 * words (src/lib/studio/backgrounds.ts), for the one provider path that may
 * refuse a second image part; it is never the primary mechanism, because words
 * are exactly what the bench proved unreliable.
 */
export interface Plate {
  url: string;
  promptFallback: string;
}

/** params.bgMode arrives off a job row as untyped JSON — narrow it, never cast it. */
function isBgMode(v: unknown): v is BgMode {
  return v === "minimal" || v === "grey" || v === "coloured";
}

function dataUri(bytes: Buffer, contentType: string): string {
  // Only claim types the providers decode; anything exotic (HEIC from an
  // iPhone, WebP) must be transcoded upstream via the bounded-size fetch.
  const t = contentType.includes("png") ? "image/png" : contentType.includes("webp") ? "image/webp" : "image/jpeg";
  return `data:${t};base64,${bytes.toString("base64")}`;
}

async function download(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) return Buffer.from(url.split(",", 2)[1], "base64");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Result download failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ── OpenAI ────────────────────────────────────────────────────────────────
/** PNG-ify once: the edits endpoint on this account accepts PNG only. */
async function toPng(bytes: Buffer, contentType: string): Promise<Buffer> {
  // Verified live: JPEG → "Invalid image file or mode"; the pipeline always
  // sent PNG too.
  if (contentType.includes("png")) return bytes;
  const sharp = (await import("sharp")).default;
  return sharp(bytes).png().toBuffer();
}

/**
 * Fetch a plate's bytes, or null if it is not there.
 *
 * A plate lives in Supabase storage and is uploaded per PROJECT, so a deploy
 * can reach an environment whose bucket is still empty. Before this, that was
 * a catalogue-wide outage: every coloured-mode Generate on that project failed
 * on a 404. A background is not worth failing a render over — if the plate
 * cannot be read the engines fall back to describing it in words, which is
 * what the 'grey' mode has always done, and the job log says so.
 */
async function fetchPlate(plate: Plate): Promise<Buffer | null> {
  try {
    const r = await fetch(plate.url, { cache: "no-store" });
    if (!r.ok) {
      console.warn(`Background plate ${plate.url} unavailable (HTTP ${r.status}) — falling back to the prompt-only backdrop`);
      return null;
    }
    return Buffer.from(await r.arrayBuffer());
  } catch (err) {
    console.warn(`Background plate ${plate.url} unreachable (${(err as Error).message}) — falling back to the prompt-only backdrop`);
    return null;
  }
}

/** The coloured prompt minus its attachment clause, plus the plate in words. */
function plateInWords(prompt: string, plate: Plate): string {
  return `${prompt.replace(/\s*Use the attached background\.?\s*$/i, "")} Background: ${plate.promptFallback}`;
}

async function runOpenAi(source: Buffer, contentType: string, prompt: string, plate?: Plate | null): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY!;
  const png = await toPng(source, contentType);

  // The edits endpoint takes FILE PARTS, not URLs — the backdrop plate has to
  // be fetched and uploaded as a second part. gpt-image models accept several
  // reference images under the repeated `image[]` field; the single-image
  // shape uses plain `image`. We send whichever matches what we have.
  let plateBytes: Buffer | null = null;
  if (plate) {
    const raw = await fetchPlate(plate);
    if (raw) plateBytes = await toPng(raw, "image/jpeg");
  }
  // No plate to attach — say it in words rather than send a prompt that points
  // at an attachment that is not there.
  const effectivePrompt = plate && !plateBytes ? plateInWords(prompt, plate) : prompt;

  const build = (withPlate: boolean, promptText: string) => {
    const form = new FormData();
    if (withPlate && plateBytes) {
      // Garment FIRST, plate second — the same order the bench validated on
      // seedream, and the order the prompt's "the attached background" implies.
      form.append("image[]", new Blob([new Uint8Array(png)], { type: "image/png" }), "input.png");
      form.append("image[]", new Blob([new Uint8Array(plateBytes)], { type: "image/png" }), "background.png");
    } else {
      form.set("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "input.png");
    }
    form.set("model", process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2");
    form.set("prompt", promptText);
    form.set("size", "auto");
    // 'medium' halves the render time vs 'high' with no visible loss on a
    // background swap (the garment pixels are preserved, not re-drawn) — the
    // slowness Ansh flagged was mostly this knob (3 Sep). Env overrides.
    form.set("quality", process.env.OPENAI_IMAGE_QUALITY ?? "medium");
    form.set("n", "1");
    return form;
  };

  const post = (form: FormData) =>
    fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });

  let r = await post(build(!!plateBytes, effectivePrompt));

  // If the installed API shape will not take a second image, the plate must
  // NOT be silently dropped — "use the attached background" with nothing
  // attached produces whatever wall the model feels like. Fall back to the
  // plate's prompt-only description (backgrounds.ts keeps one per colour for
  // exactly this) and say so in the job log via the thrown error if even that
  // fails. This is a runtime probe rather than a version check because the
  // account's model alias (OPENAI_IMAGE_MODEL) can move under us.
  if (!r.ok && plateBytes && r.status === 400) {
    const detail = (await r.text()).slice(0, 300);
    if (/image/i.test(detail)) {
      r = await post(build(false, plateInWords(prompt, plate!)));
    } else {
      throw new Error(`OpenAI HTTP 400: ${detail}`);
    }
  }

  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = await r.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return Buffer.from(b64, "base64");
}

// ── fal.ai: Seedream v5 Pro and Nano Banana 2 ─────────────────────────────
//
// Two models, one account, one key, and (below) one calling path. They differ
// in exactly two places: how you ask for an output size, and which photos they
// agree to look at.
//
// Seedream accepts width/height between these bounds; outside them the call
// is rejected, so a small source is scaled up and a huge one down — always
// along its OWN aspect ratio. v5 Pro takes the same input shape v4 did, so
// everything below carried over untouched when the endpoint moved.
const SEEDREAM_MIN_PX = 1024;

/** Human name per engine, for job logs an operator reads. */
const FAL_LABEL: Record<string, string> = { seedream: "Seedream v5 Pro", nano_banana: "Nano Banana 2", matte: "Matte composite" };

/**
 * Does this fal response body say "I refused to look at your photograph"?
 *
 * The live shape (v5 Pro, HTTP 422):
 *   {"detail":[{"loc":["body","image"],
 *     "msg":"The content could not be processed because it contained material
 *            flagged by a content checker.",
 *     "type":"content_policy_violation"}]}
 *
 * Both the machine-readable `type` and the human sentence are matched, because
 * either one alone is a string fal could re-word.
 */
function isContentRefusal(text: string): boolean {
  return /content_policy_violation|flagged by a content checker/i.test(text);
}

/**
 * A content refusal, said to a shop operator instead of at one.
 *
 * THIS IS THE LINE THAT MUST NOT BE SWALLOWED. Seedream v5 Pro's content
 * checker refuses part of this catalogue: DD-LEH-MRM-076·BLK, a black net
 * mermaid lehenga photographed on the brand's own model, comes back 422 on
 * BOTH the full-length frame and the macro crop. It is not a bad photo and it
 * is not a bad prompt — the same two files went through Nano Banana 2 without
 * a murmur. `enable_safety_checker:false` does not clear it either; fal's own
 * schema says disabling the checker needs account authorization we do not
 * have.
 *
 * The owner picked v5 Pro on 20 Sep knowing this, which makes hiding the
 * refusal the one unacceptable outcome. A raw 422 body in the job log tells a
 * shop operator nothing they can do; this tells them the engine refused the
 * photo, that the garment is not the problem, and which chip to press next.
 */
function refusalMessage(engine: EngineKind): string {
  const label = FAL_LABEL[engine] ?? engine;
  const remedy =
    engine === "seedream"
      ? "Switch this angle to the Nano Banana chip and generate again — it renders the photos Seedream refuses."
      : "Try the Seedream or OpenAI chip on this angle instead.";
  return (
    `${label} refused this photo: its content checker flagged the source image, so nothing was rendered. ` +
    `Nothing is wrong with the garment or the prompt — this is the engine's own filter, and it cannot be ` +
    `switched off on our fal account. ${remedy}`
  );
}

/** Turn a failed fal response into a sentence, refusal-aware. */
async function falFailure(engine: EngineKind, r: Response): Promise<string> {
  const text = (await r.text().catch(() => "")).slice(0, 400);
  if (isContentRefusal(text)) return refusalMessage(engine);
  return `${FAL_LABEL[engine] ?? engine} HTTP ${r.status}: ${text.slice(0, 300)}`;
}

/**
 * The output size for a source photo.
 *
 * Replaces `image_size: "auto_2K"`, which was a live defect rather than a
 * preference: "auto" let the model decide the frame, and on 9:16 phone
 * captures it decided 3:4 — re-cropping the shot and PAINTING MORE ROOM IN,
 * the precise opposite of what a background clean-up is for. Asking for the
 * source's own pixel dimensions removes the decision. DREVI_SEEDREAM_MAX_PX
 * caps the long edge (default 4096, fal's ceiling); DREVI_SEEDREAM_SIZE still
 * wins outright for a one-off experiment.
 *
 * CONSEQUENCE worth knowing: the caller fetches the source through
 * fetchImageByRef(ref, 1600), so a Drive-hosted photo arrives bounded to 1600
 * on its long edge and the render now comes back at 1600 rather than ~2K.
 * That is the honest trade — a correctly-framed 1600 beats a re-cropped 2K —
 * and the lever is the fetch bound, not this function.
 */
async function seedreamSize(source: Buffer): Promise<{ width: number; height: number } | string> {
  const override = process.env.DREVI_SEEDREAM_SIZE;
  if (override) return override;
  try {
    const sharp = (await import("sharp")).default;
    // EXIF-rotated phone photos report pre-rotation dimensions; `autoOrient`
    // is what every decoder downstream applies, so measure the same way — or a
    // portrait capture would be asked for as landscape.
    const { width: w, height: h } = await sharp(source).autoOrient().metadata();
    if (!w || !h) throw new Error("no dimensions");

    // A non-numeric override would make every comparison below false and
    // serialise width/height as null, which fal rejects — and the catch around
    // this only guards a sharp throw, so the auto_2K net would never fire.
    const rawMax = Number(process.env.DREVI_SEEDREAM_MAX_PX);
    const max = Math.max(SEEDREAM_MIN_PX, Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 4096);

    // The two bounds COMPOSE. Assigning the second over the first (as this did)
    // meant a 5000x800 crop asked for 4096x1024 — a 4:1 request for a 6.25:1
    // source, i.e. exactly the re-framing that auto_2K was removed for. Past
    // 4:1 the bounds genuinely cannot both hold; honour the long edge then,
    // because shrinking the frame is safer than changing its shape.
    const long = Math.max(w, h), short = Math.min(w, h);
    let scale = Math.min(1, max / long);
    if (short * scale < SEEDREAM_MIN_PX) scale = Math.min(SEEDREAM_MIN_PX / short, max / long);
    const fit = (n: number) => Math.max(1, Math.min(max, Math.round(n * scale)));
    return { width: fit(w), height: fit(h) };
  } catch {
    // Better a known-good enum than a failed job: auto_2K is the old default
    // and it does render — it just re-frames, which the job log will show.
    return "auto_2K";
  }
}

/**
 * Nano Banana's output resolution — deliberately NOT fal's 1K default.
 *
 * At 1K a 900×1600 source came back 768×1376. That is a DOWNSCALE, and it does
 * not stay hidden: publishWholesale derives s1200 and s800 from whatever it is
 * handed, so a 768-wide render is stretched back up into the published web
 * image and visibly softens. 2K costs 1.5× ($0.12 against $0.08) and is the
 * cheapest size that does not throw away pixels the camera actually caught.
 *
 * DREVI_NANO_RESOLUTION overrides for a one-off experiment.
 */
const NANO_RESOLUTIONS = ["0.5K", "1K", "2K", "4K"] as const;
const NANO_DEFAULT_RESOLUTION = "2K";

function nanoResolution(): string {
  const want = (process.env.DREVI_NANO_RESOLUTION ?? "").trim();
  if (!want) return NANO_DEFAULT_RESOLUTION;
  // fal rejects anything off this enum, and it would do so mid-Generate with a
  // 422 the operator cannot read. A typo in the environment is not worth a
  // failed job — fall back to the default and say so in the server log.
  if ((NANO_RESOLUTIONS as readonly string[]).includes(want)) return want;
  console.warn(`DREVI_NANO_RESOLUTION="${want}" is not one of ${NANO_RESOLUTIONS.join(", ")} — using ${NANO_DEFAULT_RESOLUTION}`);
  return NANO_DEFAULT_RESOLUTION;
}

/**
 * The half of a fal call that both models share: the plate, the image order,
 * the prompt fallback, the refusal-aware failure. `extra` supplies the fields
 * they disagree about — Seedream's image_size, Nano Banana's aspect_ratio +
 * resolution — and is the ONLY place a model-specific field belongs.
 */
async function runFal(
  cfg: { endpoint: string; engine: EngineKind; extra: (source: Buffer) => Promise<Record<string, unknown>> },
  source: Buffer,
  contentType: string,
  prompt: string,
  plate?: Plate | null,
): Promise<Buffer> {
  const key = process.env.FAL_KEY!;
  // GARMENT FIRST, PLATE SECOND. That order is what the bench validated on
  // both models: with the plate first, the model treats the garment as the
  // reference and the empty backdrop as the thing to keep.
  const imageUrls = [dataUri(source, contentType)];
  // Inlined, not handed over as a URL: fal would have to reach our storage
  // itself, and a plate that is missing or unreachable would surface as an
  // opaque fal error mid-render. Fetching it here means we find out before the
  // call and can fall back to words.
  let plateOk = false;
  if (plate) {
    const bytes = await fetchPlate(plate);
    if (bytes) { imageUrls.push(dataUri(bytes, "image/jpeg")); plateOk = true; }
  }
  const effectivePrompt = plate && !plateOk ? plateInWords(prompt, plate) : prompt;
  const r = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: effectivePrompt,
      image_urls: imageUrls,
      num_images: 1,
      ...(await cfg.extra(source)),
    }),
  });
  if (!r.ok) throw new Error(await falFailure(cfg.engine, r));
  const body = await r.json();
  const url = body?.images?.[0]?.url;
  if (!url) {
    // A refusal has only ever arrived as a 422, but a 200 carrying the same
    // `detail` and no images would otherwise read as "no images" — a message
    // that sends the operator looking for a fault that is not theirs.
    const raw = JSON.stringify(body).slice(0, 300);
    throw new Error(isContentRefusal(raw) ? refusalMessage(cfg.engine) : `${FAL_LABEL[cfg.engine] ?? cfg.engine} returned no images: ${raw}`);
  }
  return download(url);
}

function runSeedream(source: Buffer, contentType: string, prompt: string, plate?: Plate | null): Promise<Buffer> {
  return runFal(
    {
      endpoint: FAL_SEEDREAM,
      engine: "seedream",
      extra: async (src) => ({
        image_size: await seedreamSize(src),
        // Kept because v4's input shape is v5 Pro's input shape and the call
        // still accepts the field — but it no longer buys anything. v5 Pro's
        // refusals come from a checker this flag does not reach ("Disabling it
        // requires account authorization"), which is why refusalMessage exists
        // rather than a quiet retry with the checker off.
        enable_safety_checker: process.env.DREVI_SEEDREAM_SAFETY === "1",
      }),
    },
    source, contentType, prompt, plate,
  );
}

function runNanoBanana(source: Buffer, contentType: string, prompt: string, plate?: Plate | null): Promise<Buffer> {
  return runFal(
    {
      endpoint: FAL_NANO,
      engine: "nano_banana",
      extra: async () => ({
        // There is NO image_size on this model, so seedreamSize has nothing to
        // bite on. 'auto' follows the input frame — which is the entire job
        // seedreamSize was written to do: keep a 9:16 catalogue capture at 9:16
        // instead of letting the model decide it would rather be 3:4.
        aspect_ratio: "auto",
        resolution: nanoResolution(),
        // PNG, not the lossy default: publishWholesale re-encodes into s1200
        // and s800 anyway, so a JPEG here would just be a generation of loss
        // ahead of the one that actually ships.
        output_format: "png",
      }),
    },
    source, contentType, prompt, plate,
  );
}

// ── Matte composite ───────────────────────────────────────────────────────
//
// Two halves, deliberately in two files. The network half is here, beside the
// other fal calls; the pixel half is matte.ts, which never touches a socket.

/**
 * One birefnet call: the same photograph, with a real alpha channel.
 *
 * `refine_foreground` is what makes this usable on a catalogue: without it the
 * matte is a hard binary mask and a chiffon dupatta comes back opaque. With
 * it, sheer net keeps its transparency and the backdrop reads through — better
 * than expected on the hardest garment in the bench (the black net lehenga
 * Seedream's checker refuses outright).
 *
 * `operating_resolution` is the size the SEGMENTER works at, not the output
 * size: the returned PNG carries the source's own dimensions either way.
 * 2048x2048 buys a cleaner edge on hems and costs nothing extra.
 */
async function birefnetCutout(source: Buffer, contentType: string): Promise<Buffer> {
  const key = process.env.FAL_KEY!;
  const r = await fetch(FAL_BIREFNET, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: dataUri(source, contentType),
      refine_foreground: true,
      // PNG is not a preference here, it is the requirement — a JPEG has no
      // alpha channel and there would be nothing to composite.
      output_format: "png",
      operating_resolution: "2048x2048",
    }),
  });
  if (!r.ok) throw new Error(await falFailure("matte", r));
  const body = await r.json();
  const url = body?.image?.url; // birefnet returns a single `image`, not `images[]`
  if (!url) {
    const raw = JSON.stringify(body).slice(0, 300);
    throw new Error(isContentRefusal(raw) ? refusalMessage("matte") : `Matte composite returned no cut-out: ${raw}`);
  }
  return download(url);
}

/**
 * Cut the garment out and composite it onto this design's background.
 *
 * NO PROMPT. Nothing here reads one, and defaultAnglePrompt returns '' for
 * this engine on purpose (src/lib/studio/prompts.ts) — there is no model being
 * instructed, so a prompt box would be a lie about what the chip does.
 *
 * The ground depends on the design's background MODE, not just on whether a
 * plate arrived, which is why runEngine now carries bgMode: minimal and grey
 * are prompt-only for the generative engines and so send no plate, but matte
 * still has to draw something under the figure, and white and studio grey are
 * different somethings.
 */
async function runMatte(source: Buffer, contentType: string, bgMode: BgMode, plate?: Plate | null): Promise<Buffer> {
  const cutout = await birefnetCutout(source, contentType);
  let plateBytes: Buffer | null = null;
  if (bgMode === "coloured" && plate) {
    plateBytes = await fetchPlate(plate);
    if (!plateBytes) {
      // The generative engines fall back to describing the backdrop in words.
      // This one has no words — it falls back to the white ground, which is
      // the same thing minimal mode ships and is never wrong-looking.
      console.warn("Matte: coloured plate unreadable — compositing onto white instead");
    }
  }
  const { compositeMatte } = await import("./matte");
  return compositeMatte({ cutout, mode: plateBytes ? "coloured" : bgMode === "coloured" ? "minimal" : bgMode, plate: plateBytes });
}

// ── FASHN model-swap ──────────────────────────────────────────────────────
/**
 * Brand-model face reference: a pose image from DREVI_BRAND_MODEL_FOLDER_ID.
 * Prefer a file whose name mentions the angle; else the first image.
 */
/** Model subfolders available for the per-design selector (Ansh's plan §3). */
export async function listBrandModels(): Promise<string[]> {
  const folder = process.env.DREVI_BRAND_MODEL_FOLDER_ID;
  if (!folder) return [];
  try {
    const subs = await listSubfolders(folder);
    return subs.map((s) => s.name).sort();
  } catch {
    return [];
  }
}

async function brandModelRef(angle: string, model?: string | null): Promise<{ bytes: Buffer; contentType: string }> {
  const folder = process.env.DREVI_BRAND_MODEL_FOLDER_ID;
  if (!folder) throw new Error("DREVI_BRAND_MODEL_FOLDER_ID not set — needed for FASHN model-swap");

  // One subfolder per model ("Model-a", "model-b", …), poses inside. The
  // design's own choice wins, then DREVI_BRAND_MODEL, then the first folder.
  // Within a model, a pose named for the angle wins, else the first image.
  let files = await listFolderImages(folder);
  if (!files.length) {
    const subs = await listSubfolders(folder);
    if (!subs.length) throw new Error("Brand-model folder has no images or model subfolders");
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = norm(model || process.env.DREVI_BRAND_MODEL || "a");
    const sub =
      subs.find((f) => norm(f.name) === wanted) ??
      subs.find((f) => norm(f.name).endsWith(wanted)) ??
      subs[0];
    files = await listFolderImages(sub.id);
    if (!files.length) throw new Error(`Brand-model subfolder "${sub.name}" has no images`);
  }
  const match =
    files.find((f) => f.name.toLowerCase().includes(angle.toLowerCase())) ?? files[0];
  const img = await fetchImageByRef(match.id, 1600); // thumbnail pipeline → guaranteed JPEG
  if (!img) throw new Error(`Could not fetch brand-model image ${match.name}`);
  return { bytes: Buffer.from(img.body), contentType: img.contentType };
}

/**
 * Submit-only half (Vercel Hobby caps functions at 60s; FASHN runs 2–4 min).
 * Returns the prediction id; poll with pollFashn from a separate request.
 */
export async function submitFashn(args: {
  source: Buffer; contentType: string; angle: string; prompt: string; seed: number; brandModel?: string | null;
}): Promise<string> {
  const key = process.env.FASHN_API_KEY!;
  const face = await brandModelRef(args.angle, args.brandModel);
  const inputs: Record<string, unknown> = {
    model_image: dataUri(args.source, args.contentType),
    face_reference: dataUri(face.bytes, face.contentType),
    face_reference_mode: "match_base",
    resolution: "2k",
    generation_mode: "quality",
    seed: args.seed >>> 0,
    num_images: 1,
    output_format: "png",
  };
  if (args.prompt) inputs.prompt = args.prompt;
  const submit = await fetch(`${FASHN_BASE}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: "model-swap", inputs }),
  });
  if (!submit.ok) throw new Error(`FASHN /run HTTP ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const { id } = await submit.json();
  if (!id) throw new Error("FASHN /run returned no prediction id");
  return id;
}

/** One status check. status: running | completed | failed. */
export async function pollFashn(predictionId: string): Promise<{ status: "running" | "completed" | "failed"; bytes?: Buffer; error?: string }> {
  const key = process.env.FASHN_API_KEY!;
  const st = await fetch(`${FASHN_BASE}/status/${predictionId}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!st.ok) return { status: "running" }; // transient — caller retries
  const body = await st.json();
  if (body.status === "completed") {
    const url = body.output?.[0];
    if (!url) return { status: "failed", error: "FASHN completed with no output" };
    return { status: "completed", bytes: await download(url) };
  }
  if (body.status === "failed" || body.status === "canceled") {
    return { status: "failed", error: `FASHN ${body.status}: ${JSON.stringify(body.error ?? {}).slice(0, 200)}` };
  }
  return { status: "running" };
}

async function runFashn(source: Buffer, contentType: string, angle: string, prompt: string, seed: number, brandModel?: string | null): Promise<Buffer> {
  const key = process.env.FASHN_API_KEY!;
  const face = await brandModelRef(angle, brandModel);
  const inputs: Record<string, unknown> = {
    model_image: dataUri(source, contentType), // source of outfit + pose
    face_reference: dataUri(face.bytes, face.contentType),
    face_reference_mode: "match_base",
    resolution: "2k",
    generation_mode: "quality",
    seed: seed >>> 0,
    num_images: 1,
    output_format: "png",
  };
  if (prompt) inputs.prompt = prompt;

  const submit = await fetch(`${FASHN_BASE}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: "model-swap", inputs }),
  });
  if (!submit.ok) throw new Error(`FASHN /run HTTP ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const { id } = await submit.json();
  if (!id) throw new Error("FASHN /run returned no prediction id");

  const deadline = Date.now() + Number(process.env.FASHN_POLL_TIMEOUT_MS ?? 240_000);
  for (;;) {
    if (Date.now() > deadline) throw new Error("FASHN timed out — check the job on fashn.ai");
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`${FASHN_BASE}/status/${id}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!st.ok) continue; // transient poll failure — keep polling until deadline
    const body = await st.json();
    if (body.status === "completed") {
      const url = body.output?.[0];
      if (!url) throw new Error("FASHN completed with no output");
      return download(url);
    }
    if (body.status === "failed" || body.status === "canceled") {
      throw new Error(`FASHN ${body.status}: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
    }
  }
}

/** Seed derived from the SKU so re-runs of the same design are comparable. */
export function seedFor(text: string): number {
  let h = 2166136261;
  for (const c of text) h = (h ^ c.charCodeAt(0)) * 16777619;
  return h >>> 0;
}

export async function runEngine(args: {
  engine: EngineKind;
  source: Buffer;
  contentType: string;
  angle: string;
  prompt: string;
  seed: number;
  brandModel?: string | null;
  /** Public URL of the coloured-background plate — coloured mode, model angles only. */
  plateUrl?: string | null;
  /** That plate said in words, for a provider that cannot take a second image. */
  platePrompt?: string | null;
  /**
   * The design's background MODE. The generative engines carry the mode inside
   * their prompt and only ever needed the plate; matte draws the ground itself
   * and has to be told whether minimal (white) or grey was chosen. Absent on
   * job rows queued before 20 Sep — see the fallback below.
   */
  bgMode?: string | null;
}): Promise<Buffer> {
  // Parked, and loudly: a caller that still asks for model swap should get a
  // sentence it can act on, not "FASHN_API_KEY missing".
  if (args.engine === "fashn" && !fashnEnabled()) {
    throw new Error("Model swap (fashn) is disabled — set FASHN_ENABLED=true to bring it back");
  }
  const conf = engineConfigured(args.engine);
  if (!conf.ok) throw new Error(`${args.engine} is not configured — ${conf.missing} missing`);

  const plate: Plate | null = args.plateUrl
    ? { url: args.plateUrl, promptFallback: args.platePrompt?.trim() || "a plain seamless studio backdrop" }
    : null;
  if (args.engine === "openai_bg") return runOpenAi(args.source, args.contentType, args.prompt, plate);
  if (args.engine === "seedream") return runSeedream(args.source, args.contentType, args.prompt, plate);
  if (args.engine === "nano_banana") return runNanoBanana(args.source, args.contentType, args.prompt, plate);
  if (args.engine === "matte") {
    // A job queued before bgMode existed still has to render. A plate only
    // ever travels in coloured mode, so its presence identifies that mode; no
    // plate means prompt-only, and minimal is the studio default (0053).
    const mode: BgMode = isBgMode(args.bgMode) ? args.bgMode : plate ? "coloured" : "minimal";
    return runMatte(args.source, args.contentType, mode, plate);
  }
  return runFashn(args.source, args.contentType, args.angle, args.prompt, args.seed, args.brandModel);
}
