import { describe, expect, it } from "vitest";
import { exitAfterSave } from "./save-exit";

describe("exitAfterSave", () => {
  it("closes an editor that sits on the page it would push to, query and all", () => {
    expect(exitAfterSave("/admin/receipts/r1", "/admin/receipts/r1")).toBe("close");
    expect(exitAfterSave("/admin/receipts/r1?from=%2Fadmin%2Freceipts", "/admin/receipts/r1?from=%2Fadmin%2Freceipts")).toBe("close");
    expect(exitAfterSave("/admin/receipts/r1/", "/admin/receipts/r1#lines")).toBe("close");
  });

  it("navigates when the saved record lives on another page", () => {
    expect(exitAfterSave("/admin/receipts/r2", "/admin/receipts/new")).toBe("navigate");
    expect(exitAfterSave("/admin/receipts/r1", "/admin/receipts/r1/edit")).toBe("navigate");
    expect(exitAfterSave("/admin/receipts/r1?from=a", "/admin/receipts/r1?from=b")).toBe("navigate");
  });
});
