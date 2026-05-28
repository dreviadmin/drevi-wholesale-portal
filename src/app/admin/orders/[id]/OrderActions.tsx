"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOrderStatus } from "@/app/admin/orders/actions";
import { palette } from "@/lib/palette";
import type { OrderStatus } from "@/lib/types";

export function OrderActions({ orderId, status }: { orderId: string; status: OrderStatus }) {
  const router = useRouter();
  const [isPending, start] = useTransition();

  function act(next: OrderStatus, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    start(async () => { await setOrderStatus(orderId, next); router.refresh(); });
  }

  const btn = (label: string, onClick: () => void, primary = false) => (
    <button type="button" onClick={onClick} disabled={isPending} className="font-body uppercase disabled:opacity-50" style={{ fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px", background: primary ? palette.black : "transparent", color: primary ? palette.ivory : palette.black, border: primary ? "none" : `1px solid ${palette.black}` }}>{label}</button>
  );

  return (
    <div className="flex gap-2 flex-wrap">
      {status === "submitted" && btn("Confirm", () => act("confirmed"), true)}
      {status === "confirmed" && btn("Mark Fulfilled", () => act("fulfilled"), true)}
      {status !== "cancelled" && status !== "fulfilled" && btn("Cancel", () => act("cancelled", "Cancel this order?"))}
    </div>
  );
}
