import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchDriveImage } from "@/lib/drive";

// Copy track (build guide §10). ONE implementation — the workbench single
// generate and the board batch both call generateCopyForDesign. Inputs are
// the design's approved images (fallback: angle sources), its spec-mirror
// fields and tier. STRICT_SPEC_MODE (default on): an unverified-spec design
// is refused — "Awaiting Rakesh's specs" — through every path.
//
// Template: docs/reference/copy-template.md when ANSH-02 drops it in; until
// then the guide's built-in minimum — title ≤ 60 chars, 2–3 sentence
// description in brand voice (no exclamation marks, sentences end with
// periods), tags {occasion, fabric, silhouette, color}.

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

// D9: COPY_MODEL env (default claude-sonnet-4-6); hero designs use Opus.
function modelFor(tier: string): string {
  if (tier === "hero") return process.env.COPY_MODEL_HERO ?? "claude-opus-4-8";
  return process.env.COPY_MODEL ?? "claude-sonnet-4-6";
}

const BUILT_IN_TEMPLATE = `You write product copy for Drevi, an Indian occasion-wear fashion house (lehengas, sarees, sharara sets, gowns). Voice: refined, confident, tactile — never salesy. No exclamation marks. Sentences end with periods.

From the photos and the facts below, return STRICT JSON only (no markdown fence):
{"title": "<= 60 characters, Title Case, no SKU>",
 "description": "2-3 sentences: silhouette, fabric/handwork, occasion. Specific to what is visible.",
 "tags": {"occasion": "...", "fabric": "...", "silhouette": "...", "color": "..."}}`;

export async function generateCopyForDesign(designId: string, requestedBy: string): Promise<CopyResult> {
  const admin = createAdminClient();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY not configured (ANSH-03)" };

  const { data: design } = await admin
    .from("designs")
    .select("id, base_sku, color, title, category, sub_category, tier, fabric, handwork, origin, specs_verified")
    .eq("id", designId)
    .maybeSingle();
  if (!design) return { ok: false, error: "Design not found" };
  if (strictSpecMode() && !design.specs_verified) {
    return { ok: false, skipped: true, error: "Awaiting Rakesh's specs (STRICT_SPEC_MODE)" };
  }

  // Approved candidates first; angle sources as fallback. At most 3 images.
  const { data: angles } = await admin
    .from("design_angles")
    .select("angle, source_ref, approved_candidate_id, image_candidates!angle_id(id, file_ref, status)")
    .eq("design_id", designId);
  const refs: string[] = [];
  for (const a of angles ?? []) {
    const cands = (a.image_candidates as { id: string; file_ref: string; status: string }[] | null) ?? [];
    const approved = cands.find((c) => c.id === a.approved_candidate_id);
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

  const facts = [
    design.title && `Working name: ${design.title}`,
    design.category && `Category: ${design.category} / ${design.sub_category ?? ""}`,
    design.color && `Colour code: ${design.color}`,
    design.fabric && `Fabric (verified): ${design.fabric}`,
    design.handwork && `Handwork (verified): ${design.handwork}`,
    design.origin && `Origin: ${design.origin}`,
    `Tier: ${design.tier}`,
  ].filter(Boolean).join("\n");

  const model = modelFor(design.tier);
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      messages: [{ role: "user", content: [...images, { type: "text", text: `${BUILT_IN_TEMPLATE}\n\nFACTS:\n${facts}` }] }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, error: `Anthropic ${res.status}: ${detail.slice(0, 160)}` };
  }
  const body = await res.json();
  const text: string = body.content?.[0]?.text ?? "";
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
    },
    { onConflict: "design_id" },
  );
  if (error) return { ok: false, error: error.message };
  void requestedBy;
  return { ok: true, copy };
}
