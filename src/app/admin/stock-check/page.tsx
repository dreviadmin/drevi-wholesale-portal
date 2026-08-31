import { redirect } from "next/navigation";

// Folded into /admin/stock-take?tab=check (UX sprint). The route stays so the
// cockpit item and old links land in the right place.
export default function StockCheckRedirect() {
  redirect("/admin/stock-take?tab=check");
}
