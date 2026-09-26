import { describe, it, expect } from "vitest";

import {
  normalizePhone,
  formatPhone,
  toPaise,
  paiseToDecimal,
  formatPaise,
  earnBasePaise,
  earnAmountPaise,
  redeemablePaise,
  nextExpiry,
  isExpired,
  applyMovement,
  earnReversalPaise,
  redemptionCodeFrom,
  isRedemptionCode,
  describeLedgerKind,
  WALLET_DEFAULTS,
} from "./wallet-core";

describe("normalizePhone", () => {
  it("assumes India for a bare 10-digit mobile", () => {
    expect(normalizePhone("9876543210")).toBe("919876543210");
    expect(normalizePhone("98765 43210")).toBe("919876543210");
    expect(normalizePhone("+91 98765-43210")).toBe("919876543210");
    expect(normalizePhone("09876543210")).toBe("919876543210");
    expect(normalizePhone("0091 9876543210")).toBe("919876543210");
  });
  it("rejects what cannot be an Indian mobile", () => {
    expect(normalizePhone("1234")).toBeNull();
    expect(normalizePhone("911234567890")).toBeNull(); // landline-shaped
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it("keeps a foreign number as given", () => {
    expect(normalizePhone("+1 415 555 0132")).toBe("14155550132");
  });
  it("formats for display", () => {
    expect(formatPhone("919876543210")).toBe("+91 98765 43210");
  });
});

describe("money", () => {
  it("parses Shopify decimals into paise exactly", () => {
    expect(toPaise("12999.00")).toBe(1_299_900);
    expect(toPaise("1299.5")).toBe(129_950);
    expect(toPaise("0.1")).toBe(10);
    expect(toPaise(null)).toBe(0);
    expect(toPaise("abc")).toBe(0);
  });
  it("round-trips paise to a decimal string", () => {
    expect(paiseToDecimal(129_950)).toBe("1299.50");
    expect(paiseToDecimal(100_000)).toBe("1000.00");
    expect(paiseToDecimal(5)).toBe("0.05");
  });
  it("formats with Indian grouping", () => {
    expect(formatPaise(100_000)).toBe("₹1,000");
    expect(formatPaise(1_299_900)).toBe("₹12,999");
    expect(formatPaise(21_800_000)).toBe("₹2,18,000");
    expect(formatPaise(-129_950)).toBe("-₹1,299");
    expect(formatPaise(0)).toBe("₹0");
  });
});

describe("earning", () => {
  it("earns 10% of merchandise, whole rupees, ignoring fee helpers", () => {
    const base = earnBasePaise([
      { productType: "Lehenga", discountedTotalPaise: 1_299_900, quantity: 1 },
      { productType: "Service", discountedTotalPaise: 50_000, quantity: 1 }, // COD fee
      { productType: "Service", discountedTotalPaise: 150_000, quantity: 1 }, // alteration
    ]);
    expect(base).toBe(1_299_900);
    expect(earnAmountPaise(base)).toBe(129_900); // ₹1,299, not ₹1,299.90
  });
  it("uses the discounted total, so the wallet's own code is netted out", () => {
    // ₹12,999 piece with ₹1,000 wallet applied -> discountedTotal is ₹11,999
    expect(earnAmountPaise(earnBasePaise([{ productType: "Lehenga", discountedTotalPaise: 1_199_900, quantity: 1 }]))).toBe(119_900);
  });
  it("scales a partly refunded line down", () => {
    const base = earnBasePaise([{ productType: "Saree", discountedTotalPaise: 2_000_000, quantity: 2, refundedQuantity: 1 }]);
    expect(base).toBe(1_000_000);
  });
  it("never earns on nothing", () => {
    expect(earnAmountPaise(0)).toBe(0);
    expect(earnAmountPaise(-500)).toBe(0);
    expect(earnAmountPaise(900)).toBe(0); // ₹9 -> 90 paise -> rounds to ₹0
  });
  it("claws back only the excess after a refund", () => {
    // earned ₹1,299 on ₹12,999; half refunded -> should have earned ₹649 -> claw ₹650
    expect(earnReversalPaise({ earnedNetPaise: 129_900, baseAfterRefundPaise: 649_950 })).toBe(-65_000);
    // already reversed enough -> nothing
    expect(earnReversalPaise({ earnedNetPaise: 60_000, baseAfterRefundPaise: 649_950 })).toBe(0);
    // full refund -> everything back
    expect(earnReversalPaise({ earnedNetPaise: 129_900, baseAfterRefundPaise: 0 })).toBe(-129_900);
  });
});

describe("redeeming", () => {
  it("applies the whole balance when the cart can take it", () => {
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 0, subtotalPaise: 1_299_900 })).toEqual({ amount: 100_000, reason: "ok" });
  });
  it("caps at the subtotal", () => {
    expect(redeemablePaise({ balancePaise: 900_000, reservedPaise: 0, subtotalPaise: 650_000 })).toEqual({ amount: 650_000, reason: "ok" });
  });
  it("enforces the ₹5,000 minimum on the subtotal before credit", () => {
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 0, subtotalPaise: 499_900 }).reason).toBe("below_minimum");
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 0, subtotalPaise: 500_000 }).reason).toBe("ok");
  });
  it("honours a smaller requested amount, in whole rupees", () => {
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 0, subtotalPaise: 1_000_000, requestedPaise: 50_050 })).toEqual({ amount: 50_000, reason: "ok" });
  });
  it("treats open redemptions as already spent", () => {
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 100_000, subtotalPaise: 1_000_000 }).reason).toBe("no_balance");
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 40_000, subtotalPaise: 1_000_000 }).amount).toBe(60_000);
  });
  it("rejects nonsense", () => {
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 0, subtotalPaise: 0 }).reason).toBe("invalid");
    expect(redeemablePaise({ balancePaise: 100_000, reservedPaise: 0, subtotalPaise: 1_000_000, requestedPaise: -5 }).reason).toBe("invalid");
  });
});

describe("expiry and movements", () => {
  it("rolls twelve months from the latest credit", () => {
    const d = nextExpiry(new Date("2026-09-26T10:00:00Z"));
    expect(d.toISOString().slice(0, 10)).toBe("2027-09-26");
  });
  it("knows when a wallet has lapsed", () => {
    const now = new Date("2026-09-26T00:00:00Z");
    expect(isExpired("2026-09-25T23:59:59Z", now)).toBe(true);
    expect(isExpired("2026-09-27T00:00:00Z", now)).toBe(false);
    expect(isExpired(null, now)).toBe(false);
  });
  it("refuses to overdraw unless clamped", () => {
    expect(applyMovement(100_000, -40_000)).toEqual({ balanceAfter: 60_000, applied: -40_000 });
    expect(() => applyMovement(30_000, -40_000)).toThrow();
    expect(applyMovement(30_000, -40_000, true)).toEqual({ balanceAfter: 0, applied: -30_000 });
  });
});

describe("codes and words", () => {
  it("mints a WLT- code from random bytes and recognises it", () => {
    const code = redemptionCodeFrom(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code).toMatch(/^WLT-[A-Z2-9]{8}$/);
    expect(isRedemptionCode(code)).toBe(true);
    expect(isRedemptionCode("SAVE10")).toBe(false);
    expect(isRedemptionCode("wlt-abcdefgh")).toBe(true); // case-insensitive
  });
  it("describes ledger rows in plain words", () => {
    expect(describeLedgerKind("welcome", null, null, null)).toBe("Welcome credit");
    expect(describeLedgerKind("earn", "shopify_order", "gid://shopify/Order/7725351305457", null)).toBe("10% back on order #5457");
    expect(describeLedgerKind("redeem", "shopify_order", "#1091", null)).toBe("Used on order #1091");
    expect(describeLedgerKind("expire", null, null, null)).toMatch(/Expired/);
  });
  it("carries the decided defaults", () => {
    expect(WALLET_DEFAULTS.welcomePaise).toBe(100_000);
    expect(WALLET_DEFAULTS.minOrderPaise).toBe(500_000);
    expect(WALLET_DEFAULTS.expiryMonths).toBe(12);
    expect(WALLET_DEFAULTS.earnPercent).toBe(10);
  });
});
