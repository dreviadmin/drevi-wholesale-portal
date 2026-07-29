import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { loadDesignDetail } from "@/lib/studio/load";
import { captureEnabled, captureDestinationNote } from "@/lib/design-image-store";
import { Workbench } from "./Workbench";

export const dynamic = "force-dynamic";

// Workbench (build guide §9): per-angle review — source vs candidate, engine
// chips, prompt, approve/reject/regen with history (D1), gate-truthful
// destination strip. Copy panel fills in Stage 6; pushes wire up in Stage 7.
export default async function WorkbenchPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const detail = await loadDesignDetail(params.designId);
  if (!detail) notFound();
  // Engine chips light up when their key is present (UX sprint).
  const enginesEnabled = {
    fashn: !!process.env.FASHN_API_KEY,
    seedream: !!process.env.FAL_KEY,
    openai_bg: !!process.env.OPENAI_API_KEY,
  };
  return (
    <Workbench
      board={detail.board}
      angles={detail.angles}
      copy={detail.copy}
      pool={detail.pool}
      activeJobs={detail.activeJobs}
      enginesEnabled={enginesEnabled}
      uploadsOk={captureEnabled()}
      uploadsMessage={captureDestinationNote()}
    />
  );
}
