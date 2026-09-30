import { describe, it, expect } from "vitest";
import { hashToken, isTokenShaped, linkRefusal, loginLinkUrl, newToken, portalOrigin, type LinkFacts } from "./login-link-core";

const ok: LinkFacts = {
  link: { revoked_at: null },
  buyer: { status: "active", email: "royal@buyers.drevifashion.com", encrypted_password: "x" },
  sameEmailStatuses: ["active"],
  emailIsStaff: false,
};

describe("tokens", () => {
  it("mints 22-char url-safe tokens that pass the shape check", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newToken();
      expect(isTokenShaped(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("rejects junk before any lookup", () => {
    for (const bad of ["", "short", "a".repeat(23), "a".repeat(21) + "/", "a".repeat(21) + "=", null, undefined]) {
      expect(isTokenShaped(bad)).toBe(false);
    }
  });

  it("hashes deterministically and never returns the token", () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });
});

describe("loginLinkUrl", () => {
  it("builds from a bare host, a full URL or one with a trailing slash", () => {
    expect(loginLinkUrl("wholesale.drevifashion.com", "T")).toBe("https://wholesale.drevifashion.com/go/T");
    expect(loginLinkUrl("https://drevi-wholesale-portal-swart.vercel.app/", "T")).toBe("https://drevi-wholesale-portal-swart.vercel.app/go/T");
    expect(loginLinkUrl("http://localhost:3000", "T")).toBe("http://localhost:3000/go/T");
  });

  it("drops any path on the base", () => {
    expect(portalOrigin("https://example.com/login")).toBe("https://example.com");
  });
});

describe("linkRefusal", () => {
  it("lets an active, credentialed buyer in", () => {
    expect(linkRefusal(ok)).toBeNull();
  });

  it("refuses an unknown or revoked link", () => {
    expect(linkRefusal({ ...ok, link: null })).toBe("unknown");
    expect(linkRefusal({ ...ok, buyer: null })).toBe("unknown");
    expect(linkRefusal({ ...ok, link: { revoked_at: "2026-09-30T00:00:00Z" } })).toBe("revoked");
  });

  it("refuses a buyer with no login", () => {
    expect(linkRefusal({ ...ok, buyer: { ...ok.buyer!, encrypted_password: null } })).toBe("no_login");
    expect(linkRefusal({ ...ok, buyer: { ...ok.buyer!, email: null } })).toBe("no_login");
  });

  it("never opens a staff session", () => {
    expect(linkRefusal({ ...ok, emailIsStaff: true })).toBe("staff");
  });

  it("refuses suspended, pending and half-suspended duplicates", () => {
    expect(linkRefusal({ ...ok, buyer: { ...ok.buyer!, status: "suspended" } })).toBe("inactive");
    expect(linkRefusal({ ...ok, buyer: { ...ok.buyer!, status: "pending" } })).toBe("inactive");
    expect(linkRefusal({ ...ok, sameEmailStatuses: ["active", "suspended"] })).toBe("inactive");
    expect(linkRefusal({ ...ok, sameEmailStatuses: [] })).toBe("inactive");
  });
});
