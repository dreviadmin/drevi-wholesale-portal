"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ShoppingBag, Minus, Plus } from "lucide-react";
import { StockPill } from "@/components/StockPill";
import { ProductImage } from "@/components/ProductImage";
import { addToCart } from "@/app/cart/actions";
import { getStockState, qtyCap } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

export function ProductDetailView({
  product,
  initialCartCount,
}: {
  product: WholesaleProduct;
  initialCartCount: number;
}) {
  const router = useRouter();
  const images = product.image_urls ?? [];
  const [selected, setSelected] = useState(0);
  const [count, setCount] = useState(initialCartCount);
  const [toast, setToast] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const state = getStockState(product);
  const cap = qtyCap(product);
  const moq = product.min_order_qty ?? 1;
  const canOrder = state !== "sold_out";
  const [qty, setQty] = useState(Math.min(moq, cap ?? moq));

  const belowMoq = product.min_order_qty != null && qty < product.min_order_qty;
  const atCap = cap != null && qty >= cap;

  function changeQty(delta: number) {
    setQty((q) => {
      let next = q + delta;
      if (next < 1) next = 1;
      if (cap != null && next > cap) next = cap;
      return next;
    });
  }

  function handleAdd() {
    if (!canOrder || belowMoq) return;
    startTransition(async () => {
      const res = await addToCart(product.sku, qty);
      if (res.ok) {
        setCount(res.count);
        setToast("Added to cart");
      } else {
        setToast(res.message ?? "Could not add to cart");
      }
    });
  }

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3.5 sticky top-0 z-10"
        style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}
      >
        <button type="button" onClick={() => router.back()} aria-label="Back" className="flex items-center" style={{ color: palette.black }}>
          <ChevronLeft size={22} strokeWidth={1.5} />
        </button>
        <div className="font-display" style={{ fontSize: 16, letterSpacing: "0.35em", color: palette.black, fontWeight: 600 }}>
          DREVI
        </div>
        <Link href="/cart" aria-label="Cart" className="relative" style={{ color: palette.black }}>
          <ShoppingBag size={19} strokeWidth={1.5} />
          {count > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 flex items-center justify-center font-body"
              style={{ background: palette.gold, color: palette.black, fontSize: 9, fontWeight: 700, width: 16, height: 16, borderRadius: 8 }}
            >
              {count}
            </span>
          )}
        </Link>
      </div>

      <div className="max-w-3xl mx-auto md:flex md:gap-8 md:px-6 md:py-6">
        {/* Gallery */}
        <div className="md:w-1/2">
          {images.length > 0 ? (
            <>
              <div className="relative w-full overflow-hidden" style={{ aspectRatio: "4/5" }}>
                <Image src={images[selected]} alt={product.title ?? product.sku} fill sizes="(max-width:768px) 100vw, 50vw" className="object-cover" />
              </div>
              {images.length > 1 && (
                <div className="flex gap-2 px-4 md:px-0 py-3 overflow-x-auto no-scrollbar">
                  {images.map((src, i) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => setSelected(i)}
                      className="relative flex-shrink-0"
                      style={{ width: 56, height: 70, border: i === selected ? `2px solid ${palette.gold}` : "1px solid rgba(26,26,26,0.15)" }}
                    >
                      <Image src={src} alt="" fill sizes="56px" className="object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <ProductImage product={product} large />
          )}
        </div>

        {/* Details */}
        <div className="px-4 md:px-0 md:w-1/2 pb-28 md:pb-6">
          <div className="font-display mt-4 md:mt-0" style={{ color: palette.black, fontSize: 24, lineHeight: 1.2, fontWeight: 600 }}>
            {product.title ?? product.sku}
          </div>
          <div className="font-body mt-1" style={{ color: palette.mutedGreige, fontSize: 10, letterSpacing: "0.1em" }}>
            {product.sku}
          </div>

          <div className="mt-3">
            <StockPill product={product} />
          </div>

          <div className="font-display mt-4" style={{ color: palette.black, fontSize: 22, fontWeight: 600 }}>
            {formatINR(product.wholesale_price)}
          </div>

          {product.primary_fabric && (
            <div className="font-body mt-4" style={{ fontSize: 11, letterSpacing: "0.04em", color: palette.softBlack }}>
              <span style={{ color: palette.mutedGreige, textTransform: "uppercase", letterSpacing: "0.15em", fontSize: 9 }}>Fabric · </span>
              {product.primary_fabric}
            </div>
          )}

          {product.description && (
            <p className="font-body mt-3" style={{ fontSize: 12.5, lineHeight: 1.7, color: palette.softBlack }}>
              {product.description}
            </p>
          )}

          {state === "made_to_order" && (
            <p className="font-body mt-3" style={{ fontSize: 11, color: palette.goldDeep, letterSpacing: "0.04em" }}>
              Made to order · ships in {product.restock_days} days
            </p>
          )}

          {/* Qty + add */}
          {canOrder ? (
            <div className="mt-6">
              <div className="flex items-center gap-4">
                <div className="flex items-center" style={{ border: `1px solid rgba(26,26,26,0.2)` }}>
                  <button type="button" onClick={() => changeQty(-1)} aria-label="Decrease" className="px-3 py-2" style={{ color: palette.black }}>
                    <Minus size={14} strokeWidth={2} />
                  </button>
                  <span className="font-body" style={{ minWidth: 32, textAlign: "center", fontSize: 14 }}>{qty}</span>
                  <button type="button" onClick={() => changeQty(1)} disabled={atCap} aria-label="Increase" className="px-3 py-2 disabled:opacity-40" style={{ color: palette.black }}>
                    <Plus size={14} strokeWidth={2} />
                  </button>
                </div>
                {cap != null && (
                  <span className="font-body" style={{ fontSize: 10, color: palette.crimsonText, letterSpacing: "0.04em" }}>
                    Only {cap} available — not restockable.
                  </span>
                )}
              </div>

              {belowMoq && (
                <p className="font-body mt-2" style={{ fontSize: 11, color: palette.crimsonText }}>
                  Minimum {product.min_order_qty} pieces.
                </p>
              )}

              <button
                type="button"
                onClick={handleAdd}
                disabled={belowMoq || isPending}
                className="mt-4 w-full flex items-center justify-center gap-2 font-body uppercase transition-opacity disabled:opacity-50"
                style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
              >
                <Plus size={13} strokeWidth={2.5} /> {isPending ? "Adding…" : "Add to Cart"}
              </button>
            </div>
          ) : (
            <div className="mt-6 font-body uppercase" style={{ background: palette.soldBtn, color: palette.muted, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0", textAlign: "center" }}>
              Sold Out
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase"
          style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px", boxShadow: "0 8px 30px rgba(26,26,26,0.3)" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
