import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDriveImage } from "@/lib/drive";
import { loadVocab } from "@/lib/sku/vocab-live";
import { defaultCopyModel } from "./copy-models";
import { defaultCopyPrompt } from "./copy-prompt";
import { promptDesignFrom, type VocabLike } from "./facts";

export { BUILT_IN_TEMPLATE, defaultCopyPrompt, type PromptFacts } from "./copy-prompt";

// Copy track (build guide §10). ONE implementation — the workbench single
// generate and the board batch both call generateCopyForDesign. Inputs are
// the design's approved images (fallback: angle sources), its spec-mirror
// fields and tier. STRICT_SPEC_MODE (default on): an unverified-spec design
// is refused — "Awaiting Rakesh's specs" — through every path.
// The template and prompt builder live in copy-prompt.ts (pure, tested).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface CopyResult {
  ok: boolean;
  error?: string;
  skipped?: boolean; // STRICT_SPEC_MODE refusal (batch reports these)
  copy?: { title: string; description: string; tags: Record<string, string> };
}

function strictSpecMode(): boolean {
  return (process.env.STRICT_SPEC_MODE ?? "true").toLowerCase() !== "false";
}

/** opts.vocab — a batch caller loads the vocabulary once and passes it through. */
export async function generateCopyForDesign(designId: string, requestedBy: string, opts?: { vocab?: VocabLike }): Promise<CopyResult> {
  const admin = createAdminClient();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY not configured (ANSH-03)" };

  const { data: saved } = await admin
    .from("design_copy")
    .select("prompt, prompt_edited_by, model_override")
    .eq("design_id", designId)
    .maybeSingle();

  const { data: design } = await admin
    .from("designs")
    .select("id, base_sku, color, color_name, title, category, sub_category, tier, fabric, handwork, origin, specs_verified")
    .eq("id", designId)
    .maybeSingle();
  if (!design) return { ok: false, error: "Design not found" };
  if (strictSpecMode() && !design.specs_verified) {
    return { ok: false, skipped: true, error: "Awaiting Rakesh's specs (STRICT_SPEC_MODE)" };
  }

  // Approved candidates first; angle sources as fallback. At most 3 images.
  const { data: angles } = await admin
    .from("design_angles")
    .select("angle, source_ref, approved_image_id, design_images!angle_id(id, file_ref, status)")
    .eq("design_id", designId);
  const refs: string[] = [];
  for (const a of angles ?? []) {
    const cands = (a.design_images as { id: string; file_ref: string; status: string }[] | null) ?? [];
    const approved = cands.find((c) => c.id === a.approved_image_id);
    if (approved) refs.push(approved.file_ref);
  }
  if (refs.length === 0) for (const a of angles ?? []) if (a.source_ref) refs.push(a.source_ref);
  if (refs.length === 0) return { ok: false, error: "No images to describe — add sources first" };

  const images: { type: "image"; source: { type: "base64"; media_type: string; data: string } }[] = [];
  for (const ref of refs.slice(0, 3)) {
    const img = await fetchDriveImage(ref, 800);
    if (!img) continue;
    images.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.contentType.includes("png") ? "image/png" : "image/jpeg",
        data: Buffer.from(img.body).toString("base64"),
      },
    });
  }
  if (images.length === 0) return { ok: false, error: "Could not fetch any design image from Drive" };

  // An edited prompt wins; otherwise the default is rebuilt from the specs, so
  // a spec correction flows through without anyone re-saving the prompt (§8).
  // Codes resolve to names (Saree, Gold) via the live vocabulary — only on this branch.
  const prompt = saved?.prompt?.trim()
    ? saved.prompt
    : defaultCopyPrompt(promptDesignFrom(design, opts?.vocab ?? (await loadVocab())));
  const model = saved?.model_override || defaultCopyModel(design.tier);
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      // Opus 5 spends part of this budget on its thinking block before the
      // JSON — 700 could truncate mid-object, so leave generous headroom.
      max_tokens: 2000,
      messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, error: `Anthropic ${res.status}: ${detail.slice(0, 160)}` };
  }
  const body = await res.json();
  // Opus 5 prepends a `thinking` block — the copy JSON is in the text block(s),
  // not necessarily content[0].
  const text: string = ((body.content ?? []) as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  let parsed: { title?: string; description?: string; tags?: Record<string, string> };
  try {
    parsed = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return { ok: false, error: `Model returned non-JSON copy: ${text.slice(0, 120)}` };
  }
  if (!parsed.title || !parsed.description) return { ok: false, error: "Copy response missing title/description" };
  const copy = {
    title: String(parsed.title).slice(0, 60),
    description: String(parsed.description),
    tags: parsed.tags && typeof parsed.tags === "object" ? parsed.tags : {},
  };

  const { error } = await admin.from("design_copy").upsert(
    {
      design_id: designId,
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
      status: "draft",
      model,
      generated_at: new Date().toISOString(),
      edited_by: null,
      approved_by: null,
      approved_at: null,
      prompt: saved?.prompt ?? null,
      prompt_edited_by: saved?.prompt_edited_by ?? null,
      model_override: saved?.model_override ?? null,
    },
    { onConflict: "design_id" },
  );
  if (error) return { ok: false, error: error.message };
  void requestedBy;
  return { ok: true, copy };
}
