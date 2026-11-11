"use client";

import { useState } from "react";
import { ProductCard } from "@/components/ProductCard";
import { buyerVariantLabel, sortVariantsForBuyer } from "@/lib/variants";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

/**
 * One card per base SKU; size/color combos are selectable chips. The card body
 * (image, price, stepper) always reflects the selected variant, and a gold dot
 * on a chip marks variants already in the cart.
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
  readOnly = false,
  showStock = true,
}: {
  variants: WholesaleProduct[];
  cartBySku: Record<string, number>;
  onChangeQty: (product: WholesaleProduct, qty: number) => void;
  detailHrefFor?: (sku: string) => string;
  enforceCaps?: boolean;
  showPrices?: boolean;
  onGoToCart?: () => void;
  onOpenDetail?: (product: WholesaleProduct) => void;
  readOnly?: boolean;
  showStock?: boolean;
}) {
  // Chips on the size ladder (S, M, L…), not in database order.
  const ordered = sortVariantsForBuyer(variants);
  // Default to the first variant already in cart, else the first one.
  const initial = ordered.find((v) => (cartBySku[v.sku] ?? 0) > 0)?.sku ?? ordered[0].sku;
  const [selectedSku, setSelectedSku] = useState(initial);
  const selected = ordered.find((v) => v.sku === selectedSku) ?? ordered[0];

  // Names ("XL · Cream"), not codes. Mixed case at 11px rather than uppercase
  // at 8.5px: the names are longer than the codes, and uppercase at the 11px
  // floor would leave one chip per row on a phone.
  const variantBar =
    ordered.length > 1 ? (
      <div className="flex gap-1.5 mt-2 flex-wrap">
        {ordered.map((v) => {
          const active = v.sku === selected.sku;
          const inCart = (cartBySku[v.sku] ?? 0) > 0;
          return (
            <button
              key={v.sku}
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedSku(v.sku); }}
              className="flex items-center gap-1 font-body"
              style={{
                fontSize: 11,
                letterSpacing: "0.02em",
                padding: "0 9px",
                minHeight: 34,
                color: active ? palette.ivory : palette.softBlack,
                background: active ? palette.black : "transparent",
                border: active ? "none" : "1px solid rgba(26,26,26,0.2)",
              }}
            >
              {inCart && <span style={{ width: 5, height: 5, borderRadius: 5, background: palette.gold, display: "inline-block" }} />}
              {buyerVariantLabel(v.sku) ?? v.sku}
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
      readOnly={readOnly}
      showStock={showStock}
    />
  );
}
