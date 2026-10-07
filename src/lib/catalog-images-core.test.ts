import { describe, it, expect } from "vitest";
import { lineImage } from "./catalog-images-core";

const current = new Map([["DD-SUT-PLZ-028-L-PUR", "https://x/product-images/DD-SUT-PLZ-028-PUR/catalog_front-1200.jpg?v=abc"]]);

describe("lineImage", () => {
  it("a catalog line shows the catalog's current photo, not its old snapshot (DD-SUT-PLZ-028 PUR, 7 Oct)", () => {
    expect(lineImage({ sku: "dd-sut-plz-028-l-pur", image_url: "https://x/product-photos/old.png" }, current)).toBe(current.get("DD-SUT-PLZ-028-L-PUR"));
  });
  it("a custom line keeps the photo staff took", () => {
    expect(lineImage({ sku: "DD-SUT-PLZ-028-L-PUR", custom: true, image_url: "https://x/custom-items/1.jpg" }, current)).toBe("https://x/custom-items/1.jpg");
  });
  it("falls back to the snapshot when the catalog has no photo, and to null when neither has one", () => {
    expect(lineImage({ sku: "DD-LEH-FLR-001-L-RED", image_url: "https://x/a.png" }, current)).toBe("https://x/a.png");
    expect(lineImage({ sku: "DD-LEH-FLR-001-L-RED" }, current)).toBeNull();
  });
});
