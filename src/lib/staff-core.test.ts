import { describe, it, expect } from "vitest";
import { classifyStaffLookup, isRetryableAuthError } from "./staff-core";

// A failed staff_users read used to look exactly like "no row", so the admin
// layout sent a signed-in person to /login on a database blip. These pin the
// line between "we could not find out" (retry screen) and "the answer is no".

const base = { hasUser: true, authError: null, rowError: null, row: { active: true } };

describe("classifyStaffLookup", () => {
  it("no signed-in user is none", () => {
    expect(classifyStaffLookup({ ...base, hasUser: false, row: null })).toBe("none");
  });

  it("an active staff row is staff", () => {
    expect(classifyStaffLookup(base)).toBe("staff");
  });

  it("an inactive staff row is none", () => {
    expect(classifyStaffLookup({ ...base, row: { active: false } })).toBe("none");
  });

  it("no staff row (a buyer, or a removed email) is none", () => {
    expect(classifyStaffLookup({ ...base, row: null })).toBe("none");
  });

  it("a failed staff_users read is error, not none", () => {
    expect(classifyStaffLookup({ ...base, row: null, rowError: { message: "Invalid API key" } })).toBe("error");
  });

  it("a retryable auth failure is error even though no user came back", () => {
    expect(
      classifyStaffLookup({ hasUser: false, authError: { name: "AuthRetryableFetchError", status: 0 }, rowError: null, row: null }),
    ).toBe("error");
  });

  it("an auth server 5xx is error", () => {
    expect(classifyStaffLookup({ hasUser: false, authError: { name: "AuthApiError", status: 500 }, rowError: null, row: null })).toBe(
      "error",
    );
  });

  it("an invalid JWT (401) is none: the session is really gone", () => {
    expect(classifyStaffLookup({ hasUser: false, authError: { name: "AuthApiError", status: 401 }, rowError: null, row: null })).toBe(
      "none",
    );
  });

  it("a missing session is none", () => {
    expect(
      classifyStaffLookup({ hasUser: false, authError: { name: "AuthSessionMissingError", status: 400 }, rowError: null, row: null }),
    ).toBe("none");
  });
});

describe("isRetryableAuthError", () => {
  it("treats no error as not retryable", () => {
    expect(isRetryableAuthError(null)).toBe(false);
    expect(isRetryableAuthError(undefined)).toBe(false);
  });

  it("matches by name or by a 5xx status", () => {
    expect(isRetryableAuthError({ name: "AuthRetryableFetchError", status: 503 })).toBe(true);
    expect(isRetryableAuthError({ name: "AuthApiError", status: 502 })).toBe(true);
    expect(isRetryableAuthError({ name: "AuthApiError", status: 403 })).toBe(false);
    expect(isRetryableAuthError({ name: "AuthApiError" })).toBe(false);
  });
});
