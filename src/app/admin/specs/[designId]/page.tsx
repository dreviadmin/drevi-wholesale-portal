import { redirect } from "next/navigation";

// Ansh, 12 Sep: pricing, specs and supply all live on the Product Master now —
// one page per design in the Studio instead of two.
//
// This route existed for retrofit R4 §6.2, a cost-free twin of the master so
// specs could be filled on a shared counter device. Floor scope was never
// built (docs/PARKED.md ANSH-20), so both screens ended up admin-only and the
// split bought nothing but a second place to set a price. Kept as a redirect
// so older links, bookmarks and printed QR flows still land somewhere sensible.
export default function SpecsRedirect({
  params,
  searchParams,
}: {
  params: { designId: string };
  searchParams?: { from?: string };
}) {
  const from = searchParams?.from ? `?from=${encodeURIComponent(searchParams.from)}` : "";
  redirect(`/admin/studio/master/${params.designId}${from}`);
}
