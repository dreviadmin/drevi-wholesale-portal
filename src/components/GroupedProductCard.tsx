"use client";

import { useState } from "react";
import { ProductCard } from "@/components/ProductCard";
import { variantLabelOf } from "@/lib/variants";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

/**
 * One card per base SKU; size/color combos are selectable chips. The card body
 * (image, pill, price, stepper) always reflects the selected variant, and a
 * gold dot on a chip marks variants already in the cart.
 */
export function GroupedProductCard({
  variants,
  cartBySku,
  onChangeQty,
  detailHrefFor,
  enforceCaps = true,
  showPrices = true,
  onGoToCart,
  onOpenDetail,
}: {
  variants: WholesaleProduct[];
  cartBySku: Record<string, number>;
  onChangeQty: (product: WholesaleProduct, qty: number) => void;
  detailHrefFor?: (sku: string) => string;
  enforceCaps?: boolean;
  showPrices?: boolean;
  onGoToCart?: () => void;
  onOpenDetail?: (product: WholesaleProduct) => void;
}) {
  // Default to the first variant already in cart, else the first one.
  const initial = variants.find((v) => (cartBySku[v.sku] ?? 0) > 0)?.sku ?? variants[0].sku;
  const [selectedSku, setSelectedSku] = useState(initial);
  const selected = variants.find((v) => v.sku === selectedSku) ?? variants[0];

  const variantBar =
    variants.length > 1 ? (
      <div className="flex gap-1 mt-2 flex-wrap">
        {variants.map((v) => {
          const active = v.sku === selected.sku;
          const inCart = (cartBySku[v.sku] ?? 0) > 0;
          return (
            <button
              key={v.sku}
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedSku(v.sku); }}
              className="flex items-center gap-1 font-body uppercase"
              style={{
                fontSize: 8.5,
                letterSpacing: "0.08em",
                padding: "4px 7px",
                color: active ? palette.ivory : palette.softBlack,
                background: active ? palette.black : "transparent",
                border: active ? "none" : "1px solid rgba(26,26,26,0.2)",
              }}
            >
              {inCart && <span style={{ width: 5, height: 5, borderRadius: 5, background: palette.gold, display: "inline-block" }} />}
              {variantLabelOf(v.sku)}
            </button>
          );
        })}
      </div>
    ) : undefined;

  return (
    <ProductCard
      product={selected}
      showPrices={showPrices}
      cartQty={cartBySku[selected.sku] ?? 0}
      onChangeQty={onChangeQty}
      detailHref={detailHrefFor?.(selected.sku)}
      enforceCaps={enforceCaps}
      onGoToCart={onGoToCart}
      onOpenDetail={onOpenDetail}
      variantBar={variantBar}
    />
  );
}
