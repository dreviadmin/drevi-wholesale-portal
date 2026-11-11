import type { Order, OrderStatus } from "@/lib/types";

// One label map for every surface (review finding: three screens rendered raw
// "out_for_delivery" after the lifecycle grew).
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  submitted: "Submitted",
  confirmed: "Confirmed",
  packed: "Packed",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  fulfilled: "Delivered",
  cancelled: "Cancelled",
};

// The buyer's order page headline. It used to read "Order Request Received"
// whatever the order had become, delivered and cancelled included.
export const ORDER_STATUS_HEADING: Record<OrderStatus, string> = {
  submitted: "Order request received",
  confirmed: "Order confirmed",
  packed: "Packed",
  out_for_delivery: "On its way",
  delivered: "Delivered",
  fulfilled: "Delivered",
  cancelled: "Order cancelled",
};

export type OrderTimelineInput = Pick<Order, "submitted_at" | "confirmed_at" | "packed_at" | "out_for_delivery_at" | "delivered_at"> &
  Partial<Pick<Order, "status">>;

export interface OrderTimelineStep {
  status: OrderStatus;
  label: string;
  at: string;
  /**
   * The step the order is at now. The last stamped step is not always it: a
   * cancelled order's trail is history (no step is current), and a legacy
   * 'fulfilled' order has no delivered stamp, so its trail stops short.
   */
  current: boolean;
}

const TIMELINE: { status: OrderStatus; key: keyof OrderTimelineInput }[] = [
  { status: "submitted", key: "submitted_at" },
  { status: "confirmed", key: "confirmed_at" },
  { status: "packed", key: "packed_at" },
  { status: "out_for_delivery", key: "out_for_delivery_at" },
  { status: "delivered", key: "delivered_at" },
];

/**
 * The steps an order has actually passed, in lifecycle order. A step with no
 * timestamp is left out rather than guessed: packing and the courier are
 * optional (confirmed can go straight to delivered), and orders delivered
 * under the old 'fulfilled' status never got a delivered_at.
 */
export function orderTimeline(o: OrderTimelineInput): OrderTimelineStep[] {
  const now = o.status === "fulfilled" ? "delivered" : o.status;
  const steps: OrderTimelineStep[] = [];
  for (const { status, key } of TIMELINE) {
    const at = o[key];
    if (at) steps.push({ status, label: ORDER_STATUS_LABEL[status], at, current: status === now });
  }
  return steps;
}
