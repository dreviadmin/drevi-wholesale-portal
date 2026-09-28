import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { checkCustomerToken, signCustomerToken, TOKEN_MAX_AGE_S } from "./wallet-token";

const SECRET = "x".repeat(48);
const NOW = 1_790_000_000;

describe("storefront customer token", () => {
  it("accepts what the theme renders (Liquid hmac_sha256 is lowercase hex)", () => {
    const msg = `9426516377841.${NOW}`;
    const liquid = `${msg}.${createHmac("sha256", SECRET).update(msg).digest("hex")}`;
    expect(checkCustomerToken(liquid, SECRET, NOW + 60)).toBe("gid://shopify/Customer/9426516377841");
    expect(signCustomerToken(9426516377841, NOW, SECRET)).toBe(liquid);
  });
  it("rejects a forged or altered token", () => {
    const t = signCustomerToken(123, NOW, SECRET);
    expect(checkCustomerToken(t, "y".repeat(48), NOW)).toBeNull();
    expect(checkCustomerToken(t.replace(/^123\./, "124."), SECRET, NOW)).toBeNull();
    expect(checkCustomerToken("123.456.abc", SECRET, NOW)).toBeNull();
    expect(checkCustomerToken(null, SECRET, NOW)).toBeNull();
  });
  it("expires after a day and refuses the future", () => {
    const t = signCustomerToken(123, NOW, SECRET);
    expect(checkCustomerToken(t, SECRET, NOW + TOKEN_MAX_AGE_S + 1)).toBeNull();
    expect(checkCustomerToken(signCustomerToken(123, NOW + 3600, SECRET), SECRET, NOW)).toBeNull();
  });
  it("needs a secret", () => {
    expect(checkCustomerToken(signCustomerToken(1, NOW, SECRET), "", NOW)).toBeNull();
  });
});
