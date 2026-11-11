import { describe, it, expect } from "vitest";
import { INVALID_LOGIN_MESSAGE, RATE_LIMITED_MESSAGE, isRateLimited, loginErrorMessage } from "./login-error";

describe("isRateLimited", () => {
  it("a 429 is the rate limit", () => {
    expect(isRateLimited({ status: 429, code: "over_request_rate_limit" })).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
  });

  it("the rate-limit codes count without a status", () => {
    expect(isRateLimited({ code: "over_request_rate_limit" })).toBe(true);
    expect(isRateLimited({ code: "over_email_send_rate_limit" })).toBe(true);
  });

  it("a wrong password is not", () => {
    expect(isRateLimited({ status: 400, code: "invalid_credentials" })).toBe(false);
  });

  it("other failures and no error are not", () => {
    expect(isRateLimited({ status: 500, code: "unexpected_failure" })).toBe(false);
    expect(isRateLimited({ status: 400, code: "email_not_confirmed" })).toBe(false);
    expect(isRateLimited({})).toBe(false);
    expect(isRateLimited({ status: null, code: null })).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

describe("loginErrorMessage", () => {
  it("asks the buyer to wait when the limit tripped", () => {
    expect(loginErrorMessage({ status: 429, code: "over_request_rate_limit" })).toBe(RATE_LIMITED_MESSAGE);
  });

  it("keeps the generic message for every other failure", () => {
    expect(loginErrorMessage({ status: 400, code: "invalid_credentials" })).toBe(INVALID_LOGIN_MESSAGE);
    expect(loginErrorMessage({ status: 500 })).toBe(INVALID_LOGIN_MESSAGE);
    expect(loginErrorMessage(null)).toBe("Invalid username or password.");
  });
});
