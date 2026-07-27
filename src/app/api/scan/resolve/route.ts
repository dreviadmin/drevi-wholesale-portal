import { NextResponse } from "next/server";
import { getStaff, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

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

  const url = new URL(request.url);
  const sku = (url.searchParams.get("sku") ?? "").trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  // BUYER MODE (§13): only View product / Add to cart, and only for visible
  // products. Unknown or hidden SKUs read "not available" — nothing
  // operational (no retail flags, no studio ids, no create-SKU) ever leaks.
  if (!staff) {
    const supabase = createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    const adminB = createAdminClient();
    const { data: buyerRows } = await adminB
      .from("buyers").select("id, status").eq("email", user.email).not("encrypted_password", "is", null).limit(1);
    if (buyerRows?.[0]?.status !== "active") return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    const { data: prod } = await adminB
      .from("wholesale_products")
      .select("sku, title, image_urls, wholesale_visible")
      .eq("sku", sku)
      .maybeSingle();
    if (!prod || !prod.wholesale_visible) {
      return NextResponse.json({ sku, known: false, message: "Not available on the wholesale portal.", actions: [] });
    }
    return NextResponse.json({
      sku,
      known: true,
      title: prod.title,
      thumb: (prod.image_urls as string[] | null)?.[0] ?? null,
      actions: [
        { key: "view_product", label: "View product", href: `/product/${encodeURIComponent(sku)}` },
        { key: "add_to_cart", label: "Add to cart" }, // client calls the cart action
      ],
    });
  }

  const admin = createAdminClient();
  // Studio lookup key: DD-CAT-SUB-NNN…-COLOR → (base, color)
  const parts = sku.split("-");
  const designKey = parts.length >= 5 && /^\d{2,4}$/.test(parts[3])
    ? { base: parts.slice(0, 4).join("-"), color: parts[parts.length - 1] }
    : null;
  const [{ data: product }, { data: vendorInfo }, { data: design }] = await Promise.all([
    admin
      .from("wholesale_products")
      .select("sku, title, image_urls, wholesale_visible")
      .eq("sku", sku)
      .maybeSingle(),
    admin.from("product_vendor_info").select("sku, retail_price").eq("sku", sku).maybeSingle(),
    designKey
      ? admin.from("designs").select("id").eq("base_sku", designKey.base).eq("color", designKey.color).maybeSingle()
      : Promise.resolve({ data: null }),
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
    if (design?.id) actions.push({ key: "open_studio", label: "Open in studio", href: `/admin/studio/${design.id}` });
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
