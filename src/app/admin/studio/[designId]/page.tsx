import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { loadDesignDetail } from "@/lib/studio/load";
import { captureEnabled, captureDestinationNote } from "@/lib/design-image-store";
import { listBrandModels, fashnEnabled } from "@/lib/pipeline/engines";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_BG_STYLE } from "@/lib/studio/backgrounds";
import { Workbench } from "./Workbench";

export const dynamic = "force-dynamic";

// Workbench (build guide §9): per-angle review — source vs candidate, engine
// chips, prompt, approve/reject/regen with history (D1), gate-truthful
// destination strip. Copy panel fills in Stage 6; pushes wire up in Stage 7.
export default async function WorkbenchPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const detail = await loadDesignDetail(params.designId);
  if (!detail) notFound();
  // Engine chips light up when their key is present (UX sprint). fashn is
  // parked (19 Sep) — the flag keeps it dark even where a key still exists,
  // and the Workbench no longer draws its chip at all.
  const enginesEnabled = {
    // model-swap also needs the brand-model pose folder
    fashn: fashnEnabled() && !!process.env.FASHN_API_KEY && !!process.env.DREVI_BRAND_MODEL_FOLDER_ID,
    // All three fal models bill the same account, so FAL_KEY lights all three
    // chips — there is no separate Nano Banana or birefnet credential to be
    // missing on its own. matte does its compositing locally, but the cut-out
    // it composites is still a fal call.
    seedream: !!process.env.FAL_KEY,
    nano_banana: !!process.env.FAL_KEY,
    matte: !!process.env.FAL_KEY,
    openai_bg: !!process.env.OPENAI_API_KEY,
  };
  // Only model swap uses the brand-model folder, so while it is parked this
  // Drive round-trip is pure latency on every Workbench load. The call comes
  // back the moment FASHN_ENABLED does.
  const brandModels = fashnEnabled() ? await listBrandModels() : [];
  const { data: designRow } = await createAdminClient().from("designs").select("brand_model, bg_style, base_sku, color").eq("id", params.designId).maybeSingle();

  return (
    <Workbench
      board={detail.board}
      angles={detail.angles}
      copy={detail.copy}
      pool={detail.pool}
      activeJobs={detail.activeJobs}
      enginesEnabled={enginesEnabled}
      brandModels={brandModels}
      brandModel={designRow?.brand_model ?? ""}
      bgStyle={designRow?.bg_style ?? DEFAULT_BG_STYLE}
      bgSeed={`${designRow?.base_sku ?? ""}|${designRow?.color ?? ""}`}
      driveFolderId={detail.driveFolderId}
      uploadsOk={captureEnabled()}
      uploadsMessage={captureDestinationNote()}
    />
  );
}
