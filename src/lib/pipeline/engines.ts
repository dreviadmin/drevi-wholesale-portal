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
//   seedream   ByteDance Seedream v4 edit via fal.ai. Synchronous.
//   openai     gpt-image-2 /v1/images/edits. Synchronous.
//
// All three accept the source photo as bytes and return image bytes; callers
// never learn which HTTP shape each provider speaks.

const FASHN_BASE = "https://api.fashn.ai/v1";
const FAL_SYNC = "https://fal.run/fal-ai/bytedance/seedream/v4/edit";

// Approx cost per output image, for the credits column (₹-agnostic units the
// studio already displays; matches image_providers.PRICE_PER_IMAGE).
export const ENGINE_COST: Record<string, number> = { fashn: 2, seedream: 0.03, openai_bg: 0.22 };

export type EngineKind = "fashn" | "seedream" | "openai_bg";

export function engineConfigured(engine: EngineKind): { ok: boolean; missing?: string } {
  const need =
    engine === "fashn" ? "FASHN_API_KEY" : engine === "seedream" ? "FAL_KEY" : "OPENAI_API_KEY";
  return process.env[need] ? { ok: true } : { ok: false, missing: need };
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
async function runOpenAi(source: Buffer, contentType: string, prompt: string): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY!;
  // The edits endpoint on this account accepts PNG only (verified live:
  // JPEG → "Invalid image file or mode"; the pipeline always sent PNG too).
  let png = source;
  if (!contentType.includes("png")) {
    const sharp = (await import("sharp")).default;
    png = await sharp(source).png().toBuffer();
  }
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "input.png");
  form.set("model", process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2");
  form.set("prompt", prompt);
  form.set("size", "auto");
  form.set("quality", process.env.OPENAI_IMAGE_QUALITY ?? "high");
  form.set("n", "1");
  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = await r.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return Buffer.from(b64, "base64");
}

// ── Seedream (fal.ai) ─────────────────────────────────────────────────────
async function runSeedream(source: Buffer, contentType: string, prompt: string): Promise<Buffer> {
  const key = process.env.FAL_KEY!;
  const r = await fetch(FAL_SYNC, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      image_urls: [dataUri(source, contentType)],
      image_size: process.env.DREVI_SEEDREAM_SIZE ?? "auto_2K",
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
}): Promise<Buffer> {
  const conf = engineConfigured(args.engine);
  if (!conf.ok) throw new Error(`${args.engine} is not configured — ${conf.missing} missing`);
  if (args.engine === "openai_bg") return runOpenAi(args.source, args.contentType, args.prompt);
  if (args.engine === "seedream") return runSeedream(args.source, args.contentType, args.prompt);
  return runFashn(args.source, args.contentType, args.angle, args.prompt, args.seed, args.brandModel);
}
