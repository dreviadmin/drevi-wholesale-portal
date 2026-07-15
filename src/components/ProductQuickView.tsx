"use client";

import { useState } from "react";
import Image from "next/image";
import { X, Minus, Plus } from "lucide-react";
import { StockPill } from "@/components/StockPill";
import { ProductImage } from "@/components/ProductImage";
import { getStockState, qtyCap } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

// Full product detail as an overlay — used where page navigation isn't
// available (the exhibition/in-store wizard). Gallery, description, fabric,
// stock pill, and the same add/stepper controls as the cards.
export function ProductQuickView({
  product,
  cartQty = 0,
  onChangeQty,
  onClose,
  showPrices = true,
  enforceCaps = true,
  readOnly = false,
}: {
  product: WholesaleProduct;
  cartQty?: number;
  onChangeQty?: (product: WholesaleProduct, qty: number) => void;
  onClose: () => void;
  showPrices?: boolean;
  enforceCaps?: boolean;
  // Browse-only surfaces (View Catalog, Price Check): no cart controls.
  readOnly?: boolean;
}) {
  const images = product.image_urls ?? [];
  const [selected, setSelected] = useState(0);
  const state = getStockState(product);
  const cap = qtyCap(product);
  const canOrder = state !== "sold_out";
  const atCap = enforceCaps && cap != null && cartQty >= cap;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6" style={{ background: "rgba(26,26,26,0.6)" }} onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[92vh] overflow-y-auto md:flex"
        style={{ background: palette.ivory }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Gallery */}
        <div className="md:w-1/2 flex-shrink-0">
          {images.length > 0 ? (
            <>
              <div className="relative w-full" style={{ aspectRatio: "4/5" }}>
                <Image src={images[selected]} alt={product.title ?? product.sku} fill sizes="(max-width:768px) 100vw, 400px" className="object-cover" />
              </div>
              {images.length > 1 && (
                <div className="flex gap-1.5 p-2 overflow-x-auto no-scrollbar">
                  {images.map((src, i) => (
                    <button key={src} type="button" onClick={() => setSelected(i)} className="relative flex-shrink-0" style={{ width: 44, height: 55, border: i === selected ? `2px solid ${palette.gold}` : "1px solid rgba(26,26,26,0.15)" }}>
                      <Image src={src} alt="" fill sizes="44px" className="object-cover" />
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
        <div className="p-4 md:p-5 md:w-1/2 relative">
          <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3" style={{ color: palette.mutedGreige }}>
            <X size={20} strokeWidth={1.7} />
          </button>

          <div className="font-display pr-8" style={{ fontSize: 19, lineHeight: 1.25, fontWeight: 600, color: palette.black }}>
            {product.title ?? product.sku}
          </div>
          <div className="font-body mt-1" style={{ fontSize: 10, letterSpacing: "0.1em", color: palette.mutedGreige }}>{product.sku}</div>

          <div className="mt-2.5"><StockPill product={product} /></div>

          {showPrices && (
            <div className="font-display mt-3" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>
              {formatINR(product.wholesale_price)}
            </div>
          )}

          {product.min_order_qty ? (
            <div className="font-body mt-1" style={{ color: palette.goldDeep, fontSize: 10, letterSpacing: "0.05em" }}>
              Minimum {product.min_order_qty} pieces
            </div>
          ) : null}

          {product.primary_fabric && (
            <div className="font-body mt-3" style={{ fontSize: 11, color: palette.softBlack }}>
              <span style={{ color: palette.mutedGreige, textTransform: "uppercase", letterSpacing: "0.15em", fontSize: 9 }}>Fabric · </span>
              {product.primary_fabric}
            </div>
          )}
          {product.description && (
            <p className="font-body mt-2" style={{ fontSize: 12, lineHeight: 1.65, color: palette.softBlack }}>{product.description}</p>
          )}

          {/* Add / stepper (hidden on browse-only surfaces) */}
          {readOnly ? null : (
          <div className="mt-4">
            {!canOrder ? (
              <div className="font-body uppercase text-center" style={{ background: palette.soldBtn, color: palette.muted, fontSize: 10, letterSpacing: "0.2em", padding: "11px 0" }}>Sold Out</div>
            ) : cartQty > 0 ? (
              <div className="flex items-center gap-3">
                <div className="flex items-center" style={{ border: "1px solid rgba(26,26,26,0.2)" }}>
                  <button type="button" onClick={() => onChangeQty?.(product, cartQty - 1)} className="px-3 py-2" aria-label="Decrease"><Minus size={14} strokeWidth={2} /></button>
                  <span className="font-body" style={{ minWidth: 30, textAlign: "center", fontSize: 14, fontWeight: 600 }}>{cartQty}</span>
                  <button type="button" onClick={() => !atCap && onChangeQty?.(product, cartQty + 1)} disabled={atCap} className="px-3 py-2 disabled:opacity-40" aria-label="Increase"><Plus size={14} strokeWidth={2} /></button>
                </div>
                <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.06em" }}>In cart</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onChangeQty?.(product, product.min_order_qty ?? 1)}
                className="w-full flex items-center justify-center gap-1.5 font-body uppercase"
                style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.2em", padding: "11px 0" }}
              >
                <Plus size={12} strokeWidth={2.5} /> Add to Cart
              </button>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
