import { requireAdminOrRedirect } from "@/lib/staff";
import { loadBoard } from "@/lib/studio/load";
import { loadStudioBuckets } from "@/lib/studio/buckets-db";
import { StudioBoard } from "./StudioBoard";

export const dynamic = "force-dynamic";

// Studio board (build guide §7.4): every design at its derived state, filter
// chips with live counts, multiselect batch bar. Rows drill into the
// workbench (skeleton until Stage 5).
export default async function StudioPage() {
  await requireAdminOrRedirect();
  // The board carries retired designs down and hides them client-side —
  // that is what lets "Show discontinued" work without a round trip.
  const [rows, buckets] = await Promise.all([loadBoard({ includeDiscontinued: true }), loadStudioBuckets()]);
  return <StudioBoard rows={rows} buckets={buckets} />;
}
