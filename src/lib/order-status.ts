import type { OrderStatus } from "@/lib/types";

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
