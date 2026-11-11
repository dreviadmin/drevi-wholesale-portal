"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ShoppingBag, Minus, Plus } from "lucide-react";
import { ProductImage } from "@/components/ProductImage";
import { useInAppBack } from "@/components/InAppHistory";
import { QtyField } from "@/components/QtyField";
import { addToCart } from "@/app/cart/actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import type { WholesaleProduct } from "@/lib/types";

export function ProductDetailView({
  product,
  initialCartCount,
}: {
  product: WholesaleProduct;
  initialCartCount: number;
  /**
   * Still accepted so page.tsx keeps compiling, but nothing renders it: the
   * buyer page no longer states stock or lead time. Optional so the loader in
   * page.tsx can be dropped without touching this file again.
   */
}) {
  const back = useInAppBack("/home");
  const images = product.image_urls ?? [];
  const [selected, setSelected] = useState(0);
  const [count, setCount] = useState(initialCartCount);
  // The shared timer, so "Added to cart" clears itself instead of sitting
  // over the bottom of the page until the buyer navigates away.
  const [toast, flash] = useToast();
  const [isPending, startTransition] = useTransition();

  // The buyer asks for whatever they want; feasibility is settled on the call,
  // so there is no cap, no minimum and no sold-out door on this page.
  const [qty, setQty] = useState(1);

  function changeQty(delta: number) {
    setQty((q) => Math.max(1, q + delta));
  }

  function handleAdd() {
    startTransition(async () => {
      const res = await addToCart(product.sku, qty);
      if (res.ok) {
        setCount(res.pieces);
        flash("Added to cart");
      } else {
        flash(res.message ?? "Could not add to cart");
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
        {/* router.back() alone did nothing when the product was opened straight
            from a WhatsApp link: nothing in the app was behind it. Home then. */}
        <button type="button" onClick={back} aria-label="Back" className="flex items-center justify-center" style={{ color: palette.black, padding: 11, margin: -11 }}>
          <ChevronLeft size={22} strokeWidth={1.5} />
        </button>
        <Link href="/home" aria-label="Home" className="font-display" style={{ fontSize: 16, letterSpacing: "0.35em", color: palette.black, fontWeight: 600, padding: "6px 4px" }}>
          DREVI
        </Link>
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
              <div className="relative w-full overflow-hidden" style={{ aspectRatio: "9/16" }}>
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

          {/* Qty + add */}
          <div className="mt-6">
            {/* Typed or stepped; the server clamps on Add exactly as before. */}
            <div className="flex items-center" style={{ border: `1px solid rgba(26,26,26,0.2)`, width: "fit-content" }}>
              <button type="button" onClick={() => changeQty(-1)} aria-label="Decrease" className="flex items-center justify-center" style={{ color: palette.black, width: 44, height: 44 }}>
                <Minus size={14} strokeWidth={2} />
              </button>
              <QtyField value={qty} min={1} onCommit={setQty} width={56} height={44} />
              <button type="button" onClick={() => changeQty(1)} aria-label="Increase" className="flex items-center justify-center" style={{ color: palette.black, width: 44, height: 44 }}>
                <Plus size={14} strokeWidth={2} />
              </button>
            </div>

            <button
              type="button"
              onClick={handleAdd}
              disabled={isPending}
              className="mt-4 w-full flex items-center justify-center gap-2 font-body uppercase transition-opacity disabled:opacity-50"
              style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
            >
              <Plus size={13} strokeWidth={2.5} /> {isPending ? "Adding…" : "Add to Cart"}
            </button>
          </div>
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
