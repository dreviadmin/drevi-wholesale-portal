import { requireAdminOrRedirect } from "@/lib/staff";
import { StockTake } from "./StockTake";

export const dynamic = "force-dynamic";

// Retrofit R8 §10.2b — Stock space, admin role. Device/floor scope is parked
// as ANSH-20, so this ships gated on the admin role for now.
export default async function StockTakePage() {
  await requireAdminOrRedirect();
  return <StockTake />;
}
