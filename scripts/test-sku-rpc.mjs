#!/usr/bin/env node
// M1 acceptance: two parallel same-CAT-SUB generates get consecutive numbers,
// and a duplicate variant raises the specced Goods-Receipt message.
// Uses a throwaway TST-RPC namespace and cleans up after itself.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: (u, i) => fetch(u, { ...i, cache: "no-store" }) },
});

const gen = (color, size) =>
  admin.rpc("generate_sku", {
    p_mode: "new", p_cat: "TST", p_sub: "RPC", p_base_sku: null,
    p_color: color, p_size: size, p_description: "rpc test", p_created_by: "test@drevi", p_number_floor: 0,
  });

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  // 1. Parallel mints → consecutive, distinct numbers.
  const [a, b] = await Promise.all([gen("RED", "M"), gen("BLU", "L")]);
  check("parallel mints both succeed", !a.error && !b.error, a.error?.message ?? b.error?.message ?? "");
  if (!a.error && !b.error) {
    const nums = [a.data.num, b.data.num].sort((x, y) => x - y);
    check("numbers are consecutive + distinct", nums[1] === nums[0] + 1, `got ${nums.join(", ")}`);
  }

  // 2. Duplicate variant → specced message.
  const first = await admin.rpc("generate_sku", {
    p_mode: "new", p_cat: "TST", p_sub: "RPC", p_base_sku: null,
    p_color: "GRN", p_size: "S", p_description: "", p_created_by: "test@drevi", p_number_floor: 0,
  });
  check("third mint succeeds", !first.error, first.error?.message ?? "");
  const dup = await admin.rpc("generate_sku", {
    p_mode: "variant", p_cat: null, p_sub: null, p_base_sku: first.data?.base_sku,
    p_color: "GRN", p_size: "S", p_description: "", p_created_by: "test@drevi", p_number_floor: 0,
  });
  check("duplicate variant rejected", !!dup.error);
  check(
    "duplicate message has timestamp/creator/GR hint",
    !!dup.error && /created .* by test@drevi/.test(dup.error.message) && dup.error.message.includes("log a Goods Receipt instead"),
    dup.error?.message ?? "",
  );

  // 3. Variant of an existing base with a NEW color succeeds and derives cat/sub.
  const varOk = await admin.rpc("generate_sku", {
    p_mode: "variant", p_cat: null, p_sub: null, p_base_sku: first.data?.base_sku,
    p_color: "YLW", p_size: "S", p_description: "", p_created_by: "test@drevi", p_number_floor: 0,
  });
  check("variant with new color succeeds", !varOk.error && varOk.data?.variant_sku === `${first.data?.base_sku}-S-YLW`, varOk.error?.message ?? varOk.data?.variant_sku);

  // 4. Floor is respected.
  const floored = await admin.rpc("generate_sku", {
    p_mode: "new", p_cat: "TST", p_sub: "RPC", p_base_sku: null,
    p_color: "BLK", p_size: "M", p_description: "", p_created_by: "test@drevi", p_number_floor: 500,
  });
  check("sheet floor respected", !floored.error && floored.data?.num === 501, `got ${floored.data?.num}`);
} finally {
  const { count } = await admin.from("sku_registry").delete({ count: "exact" }).eq("category", "TST").eq("sub_category", "RPC");
  console.log(`cleanup: removed ${count} TST-RPC rows`);
}
process.exit(failed ? 1 : 0);
