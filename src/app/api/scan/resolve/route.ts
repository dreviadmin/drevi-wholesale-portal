import { NextResponse } from "next/server";
import { getStaff, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Global scan sheet resolver (build guide §6.5). Actions are assembled HERE,
// role-gated — the client renders what it's given and only adds the two
// purely-client actions (add-to-bill when a wizard draft exists in
// localStorage, add-to-print-sheet which writes the Stage 1 tray).

export interface ScanAction {
  key: string;
  label: string;
  href?: string; // client-side actions (print tray) ship without one
}

export async function GET(request: Request) {
  const staff = await getStaff();
  if (!staff) return NextResponse.json({ error: "Not authorized" }, { status: 401 });

  const url = new URL(request.url);
  const sku = (url.searchParams.get("sku") ?? "").trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  const admin = createAdminClient();
  const [{ data: product }, { data: vendorInfo }] = await Promise.all([
    admin
      .from("wholesale_products")
      .select("sku, title, image_urls, wholesale_visible")
      .eq("sku", sku)
      .maybeSingle(),
    admin.from("product_vendor_info").select("sku, retail_price").eq("sku", sku).maybeSingle(),
  ]);

  const known = !!(product || vendorInfo);
  const isAdmin = isAdminRole(staff.role);

  if (!known) {
    return NextResponse.json({
      sku,
      known: false,
      actions: [
        // Generator route access is staff+ (Phase 1 matrix).
        { key: "create_sku", label: "Create SKU", href: `/admin/sku-generator?variant=${encodeURIComponent(sku)}` },
      ] satisfies ScanAction[],
    });
  }

  const actions: ScanAction[] = [
    { key: "retail_check", label: "Check retail price", href: `/admin/retail-check?sku=${encodeURIComponent(sku)}` },
    // add_to_bill is appended CLIENT-side when a wizard draft exists.
  ];
  if (isAdmin) {
    actions.push({ key: "log_receipt", label: "Log into a receipt", href: `/admin/receipts/new?sku=${encodeURIComponent(sku)}` });
    actions.push({ key: "edit_master", label: "Edit product master", href: `/admin/manage-catalog?sku=${encodeURIComponent(sku)}` });
  }
  actions.push({ key: "add_to_print", label: "Add to print sheet" }); // client handles

  return NextResponse.json({
    sku,
    known: true,
    title: product?.title ?? null,
    thumb: (product?.image_urls as string[] | null)?.[0] ?? null,
    retail_price_set: (vendorInfo?.retail_price ?? 0) > 0,
    actions,
  });
}
