import { requireAdminOrRedirect } from "@/lib/staff";
import { loadBoard } from "@/lib/studio/load";
import { StudioBoard } from "./StudioBoard";

export const dynamic = "force-dynamic";

// Studio board (build guide §7.4): every design at its derived state, filter
// chips with live counts, multiselect batch bar. Rows drill into the
// workbench (skeleton until Stage 5).
export default async function StudioPage() {
  await requireAdminOrRedirect();
  const rows = await loadBoard();
  return <StudioBoard rows={rows} />;
}
