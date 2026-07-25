import { notFound } from "next/navigation";
import { requireAdminOrRedirect } from "@/lib/staff";
import { loadDesignDetail } from "@/lib/studio/load";
import { Workbench } from "./Workbench";

export const dynamic = "force-dynamic";

// Workbench (build guide §9): per-angle review — source vs candidate, engine
// chips, prompt, approve/reject/regen with history (D1), gate-truthful
// destination strip. Copy panel fills in Stage 6; pushes wire up in Stage 7.
export default async function WorkbenchPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const detail = await loadDesignDetail(params.designId);
  if (!detail) notFound();
  const openaiEnabled = (process.env.OPENAI_BG_ENABLED ?? "").toLowerCase() === "true";
  return <Workbench board={detail.board} angles={detail.angles} copy={detail.copy} activeJobs={detail.activeJobs} openaiEnabled={openaiEnabled} />;
}
