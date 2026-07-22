"use server";

import { requireStaff } from "@/lib/staff";
import { syncProducts } from "@/lib/sync";

// On-demand full resync from the Catalog page (any staff role): sheet fields,
// prices, visibility AND Drive photos — the same run the 10-min cron does, so
// a price or photo just fixed in the sheet shows up on the shop floor now.
export async function resyncCatalog(): Promise<{
  ok: boolean;
  synced?: number;
  imageFetches?: number;
  hidden?: number;
  warnings?: string[];
  error?: string;
}> {
  try {
    await requireStaff();
  } catch {
    return { ok: false, error: "Not signed in." };
  }
  try {
    // Manual runs get a bigger photo budget than the 10-min cron (someone
    // clicking Sync usually just uploaded photos and wants them NOW); 40
    // keeps the three-source chain inside the route's 60s cap.
    const res = await syncProducts({ driveBudget: 40 });
    return { ok: true, synced: res.synced, imageFetches: res.image_fetches, hidden: res.hidden, warnings: res.warnings };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
