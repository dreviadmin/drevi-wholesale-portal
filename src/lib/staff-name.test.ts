import { describe, it, expect } from "vitest";
import { staffFirstName } from "./staff-name";

describe("staffFirstName", () => {
  it("takes the first word of the name", () => {
    expect(staffFirstName({ name: "Abhishek Naik", email: "a@drevifashion.com" })).toBe("Abhishek");
  });

  it("ignores stray spaces around and inside the name", () => {
    expect(staffFirstName({ name: "  Rakesh   Kumar ", email: "r@drevifashion.com" })).toBe("Rakesh");
  });

  it("falls back to the email before the @ when there is no name", () => {
    expect(staffFirstName({ name: null, email: "counter@drevifashion.com" })).toBe("counter");
    expect(staffFirstName({ name: "", email: "counter@drevifashion.com" })).toBe("counter");
    expect(staffFirstName({ name: "   ", email: "counter@drevifashion.com" })).toBe("counter");
  });
});
