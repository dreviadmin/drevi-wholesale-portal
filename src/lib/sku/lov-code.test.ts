import { describe, it, expect } from "vitest";
import { CATEGORIES, COLOR_GROUPS, SIZES } from "./vocab";
import { lovCodeError } from "./lov-code";

describe("lovCodeError", () => {
  it("accepts every code the static vocabulary already mints with", () => {
    for (const [cat, c] of Object.entries(CATEGORIES)) {
      expect(lovCodeError("category", cat)).toBeNull();
      for (const sub of Object.keys(c.subs)) expect(lovCodeError("sub_category", `${cat}-${sub}`)).toBeNull();
    }
    for (const g of COLOR_GROUPS) for (const [code] of g.items) expect(lovCodeError("color", code)).toBeNull();
    for (const size of Object.keys(SIZES)) expect(lovCodeError("size", size)).toBeNull();
  });

  it("refuses a category BASE_SKU_RE would reject later", () => {
    expect(lovCodeError("category", "BRIDAL")).not.toBeNull(); // 6 letters
    expect(lovCodeError("category", "L")).not.toBeNull();
    expect(lovCodeError("category", "LE1")).not.toBeNull(); // digits aren't allowed there
  });

  it("needs the CAT- scope on a sub-category", () => {
    expect(lovCodeError("sub_category", "FLR")).not.toBeNull();
    expect(lovCodeError("sub_category", "LEH-FLARED")).not.toBeNull();
    expect(lovCodeError("sub_category", "BRD-A1")).toBeNull();
  });

  it("refuses hyphens and spaces in colours and sizes", () => {
    expect(lovCodeError("color", "RS-GLD")).not.toBeNull();
    expect(lovCodeError("color", "ROSE GOLD")).not.toBeNull();
    expect(lovCodeError("color", "RSGLD")).toBeNull();
    expect(lovCodeError("size", "2-3Y")).not.toBeNull();
    expect(lovCodeError("size", "XXXXL")).toBeNull();
  });

  it("leaves fabric and occasion free-form", () => {
    expect(lovCodeError("fabric", "RAW SILK / ORGANZA")).toBeNull();
    expect(lovCodeError("occasion", "MEHENDI-HALDI")).toBeNull();
  });
});
