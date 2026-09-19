import "server-only";

import { fetchImageByRef } from "@/lib/design-image-store";
import { listFolderImages, listSubfolders } from "@/lib/drive";

// UX sprint (29 Jul) — the three working generation engines, run in-process.
//
// Ported from pipeline/scripts/image_providers.py + 03_fashn_runner.py so the
// portal no longer depends on the parked hosted runner (ANSH-04):
//
//   fashn      FASHN model-swap — keeps the garment + pose from the source
//              photo, swaps identity to a brand-model reference. Async API:
//              submit /v1/run → poll /v1/status/<id>.
//              PARKED since 19 Sep — see fashnEnabled() below.
//   seedream   ByteDance Seedream v4 edit via fal.ai. Synchronous.
//   openai     gpt-image-2 /v1/images/edits. Synchronous.
//
// All three accept the source photo as bytes and return image bytes; callers
// never learn which HTTP shape each provider speaks. Since 19 Sep the two
// live ones also accept an optional coloured-background PLATE (see Plate) —
// a second image, sent after the garment, that shows the model the backdrop
// instead of describing it.

const FASHN_BASE = "https://api.fashn.ai/v1";
const FAL_SYNC = "https://fal.run/fal-ai/bytedance/seedream/v4/edit";

// Approx cost per output image, for the credits column (₹-agnostic units the
// studio already displays; matches image_providers.PRICE_PER_IMAGE).
export const ENGINE_COST: Record<string, number> = { fashn: 2, seedream: 0.03, openai_bg: 0.22 };

export type EngineKind = "fashn" | "seedream" | "openai_bg";

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
  const need =
    engine === "fashn" ? "FASHN_API_KEY" : engine === "seedream" ? "FAL_KEY" : "OPENAI_API_KEY";
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

// ── Seedream (fal.ai) ─────────────────────────────────────────────────────
// Seedream v4 accepts width/height between these bounds; outside them the call
// is rejected, so a small source is scaled up and a huge one down — always
// along its OWN aspect ratio.
const SEEDREAM_MIN_PX = 1024;

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

async function runSeedream(source: Buffer, contentType: string, prompt: string, plate?: Plate | null): Promise<Buffer> {
  const key = process.env.FAL_KEY!;
  // GARMENT FIRST, PLATE SECOND. That order is what the bench validated: with
  // the plate first, the model treats the garment as the reference and the
  // empty backdrop as the thing to keep.
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
  const r = await fetch(FAL_SYNC, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: effectivePrompt,
      image_urls: imageUrls,
      image_size: await seedreamSize(source),
      num_images: 1,
      // Off by default: fal's checker false-positives on fitted ethnic wear
      // (these are the brand's own catalog photos) — same call as the pipeline.
      enable_safety_checker: process.env.DREVI_SEEDREAM_SAFETY === "1",
    }),
  });
  if (!r.ok) throw new Error(`fal HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = await r.json();
  const url = body?.images?.[0]?.url;
  if (!url) throw new Error(`fal returned no images: ${JSON.stringify(body).slice(0, 200)}`);
  return download(url);
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
  return runFashn(args.source, args.contentType, args.angle, args.prompt, args.seed, args.brandModel);
}
