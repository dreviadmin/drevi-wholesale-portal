import { describe, it, expect } from "vitest";
import { ORDER_STATUS_HEADING, ORDER_STATUS_LABEL, orderTimeline, type OrderTimelineInput } from "./order-status";

const none: OrderTimelineInput = {
  submitted_at: "2026-10-01T05:00:00Z",
  confirmed_at: null,
  packed_at: null,
  out_for_delivery_at: null,
  delivered_at: null,
};

describe("order status words", () => {
  it("labels and headings cover the same statuses", () => {
    expect(Object.keys(ORDER_STATUS_HEADING).sort()).toEqual(Object.keys(ORDER_STATUS_LABEL).sort());
  });

  it("buyers read the legacy fulfilled status as Delivered", () => {
    expect(ORDER_STATUS_LABEL.fulfilled).toBe(ORDER_STATUS_LABEL.delivered);
    expect(ORDER_STATUS_HEADING.fulfilled).toBe("Delivered");
  });

  it("a packed order reads Packed, not 'Being packed'", () => {
    expect(ORDER_STATUS_LABEL.packed).toBe("Packed");
  });

  it("only a submitted order says the request was received", () => {
    expect(ORDER_STATUS_HEADING.submitted).toBe("Order request received");
    for (const [status, heading] of Object.entries(ORDER_STATUS_HEADING)) {
      if (status !== "submitted") expect(heading).not.toMatch(/received/i);
    }
  });
});

describe("orderTimeline", () => {
  it("a new order has the one step", () => {
    expect(orderTimeline(none)).toEqual([{ status: "submitted", label: "Submitted", at: none.submitted_at }]);
  });

  it("lists every stamped step in lifecycle order", () => {
    const steps = orderTimeline({
      submitted_at: "2026-10-01T05:00:00Z",
      confirmed_at: "2026-10-02T05:00:00Z",
      packed_at: "2026-10-03T05:00:00Z",
      out_for_delivery_at: "2026-10-04T05:00:00Z",
      delivered_at: "2026-10-05T05:00:00Z",
    });
    expect(steps.map((s) => s.status)).toEqual(["submitted", "confirmed", "packed", "out_for_delivery", "delivered"]);
    expect(steps.map((s) => s.label)).toEqual(["Submitted", "Confirmed", "Packed", "Out for delivery", "Delivered"]);
    expect(steps[3].at).toBe("2026-10-04T05:00:00Z");
  });

  it("skips the stages an order went past without a stamp", () => {
    // Confirmed straight to delivered: no packing, no courier step.
    const steps = orderTimeline({ ...none, confirmed_at: "2026-10-02T05:00:00Z", delivered_at: "2026-10-03T05:00:00Z" });
    expect(steps.map((s) => s.status)).toEqual(["submitted", "confirmed", "delivered"]);
  });

  it("an order closed under the old fulfilled status stops at its last stamp", () => {
    const steps = orderTimeline({ ...none, confirmed_at: "2026-10-02T05:00:00Z" });
    expect(steps.map((s) => s.status)).toEqual(["submitted", "confirmed"]);
  });

  it("treats an empty string like a missing stamp", () => {
    const steps = orderTimeline({ ...none, packed_at: "" });
    expect(steps.map((s) => s.status)).toEqual(["submitted"]);
  });
});
