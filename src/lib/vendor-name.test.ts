import { describe, it, expect } from "vitest";
import { escapeIlike, findVendorByName } from "./vendor-name";

describe("escapeIlike", () => {
  it("leaves an ordinary name alone", () => {
    expect(escapeIlike("Ravi Textiles")).toBe("Ravi Textiles");
  });

  it("escapes the LIKE wildcards so they match only themselves", () => {
    expect(escapeIlike("50% Off")).toBe("50\\% Off");
    expect(escapeIlike("A_B")).toBe("A\\_B");
    expect(escapeIlike("%")).toBe("\\%");
  });

  it("escapes a backslash first, so it cannot swallow the next escape", () => {
    expect(escapeIlike("A\\%")).toBe("A\\\\\\%");
  });
});

describe("findVendorByName", () => {
  const rows = [
    { id: "1", name: "Ravi Textiles", active: true },
    { id: "2", name: "Ravi Textiles Annexe", active: false },
    { id: "3", name: "AxB", active: true },
  ];

  it("matches ignoring case and outer spaces, as the unique index does", () => {
    expect(findVendorByName(rows, "  ravi TEXTILES ")?.id).toBe("1");
  });

  it("finds an inactive vendor too, so it can be switched back on", () => {
    expect(findVendorByName(rows, "ravi textiles annexe")?.id).toBe("2");
  });

  it("never treats a longer or wildcard-looking name as the same vendor", () => {
    expect(findVendorByName(rows, "Ravi")).toBeUndefined();
    expect(findVendorByName(rows, "A*B")).toBeUndefined(); // PostgREST reads * as %; the exact check catches it
    expect(findVendorByName(rows, "A_B")).toBeUndefined();
  });

  it("finds nothing for a blank name", () => {
    expect(findVendorByName(rows, "   ")).toBeUndefined();
  });
});
