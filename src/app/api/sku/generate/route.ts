import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidCatSub, ALL_COLOR_CODES, ALL_SIZE_CODES, BASE_SKU_RE } from "@/lib/sku/vocab";
import { dualMode, sheetNumberFloor, knownSkuFloor, mirrorOne } from "@/lib/sku/registry-sheet";

export const dynamic = "force-dynamic";

// Mint a SKU (staff+). Vocab validation lives HERE (TS is the vocab source);
// the RPC enforces shape, uniqueness and atomicity.
export async function POST(request: Request) {
  let staff;
  try {
    staff = await requireStaff();
  } catch {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  let body: { mode?: string; cat?: string; sub?: string; baseSku?: string; color?: string; size?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode === "variant" ? "variant" : body.mode === "new" ? "new" : null;
  if (!mode) return NextResponse.json({ error: "mode must be 'new' or 'variant'" }, { status: 400 });

  const color = (body.color ?? "").trim().toUpperCase();
  const size = (body.size ?? "").trim().toUpperCase();
  if (!ALL_COLOR_CODES.has(color)) return NextResponse.json({ error: `Unknown color code "${color}"` }, { status: 400 });
  if (!ALL_SIZE_CODES.has(size)) return NextResponse.json({ error: `Unknown size code "${size}"` }, { status: 400 });

  let cat = (body.cat ?? "").trim().toUpperCase();
  let sub = (body.sub ?? "").trim().toUpperCase();
  const baseSku = (body.baseSku ?? "").trim().toUpperCase();

  if (mode === "new") {
    if (!isValidCatSub(cat, sub)) return NextResponse.json({ error: `Unknown category/sub-category "${cat}-${sub}"` }, { status: 400 });
  } else {
    if (!BASE_SKU_RE.test(baseSku)) return NextResponse.json({ error: `"${baseSku}" is not a valid base SKU` }, { status: 400 });
    cat = baseSku.split("-")[1];
    sub = baseSku.split("-")[2];
  }

  // Dual-mode transition safety: live sheet floor closes the cron-lag window.
  const warnings: string[] = [];
  let floor = 0;
  if (mode === "new") {
    // Product-table floor always applies (legacy SKUs predate the registry).
    floor = await knownSkuFloor(cat, sub);
    if (dualMode()) {
      const f = await sheetNumberFloor(cat, sub);
      floor = Math.max(floor, f.floor);
      if (f.warning) warnings.push(f.warning);
    }
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("generate_sku", {
    p_mode: mode,
    p_cat: mode === "new" ? cat : null,
    p_sub: mode === "new" ? sub : null,
    p_base_sku: mode === "variant" ? baseSku : null,
    p_color: color,
    p_size: size,
    p_description: (body.description ?? "").trim(),
    p_created_by: staff.email,
    p_number_floor: floor,
  });
  if (error) {
    const duplicate = error.message.includes("log a Goods Receipt instead");
    return NextResponse.json({ error: error.message, duplicate }, { status: duplicate ? 409 : 400 });
  }

  const result = data as { base_sku: string; variant_sku: string; num: number };
  // Best-effort inline mirror — the cron is the retry path.
  try {
    await mirrorOne(result.variant_sku);
  } catch (err) {
    console.warn("sku mirror (inline) failed:", (err as Error).message);
  }

  return NextResponse.json({ baseSku: result.base_sku, variantSku: result.variant_sku, num: result.num, warnings });
}
