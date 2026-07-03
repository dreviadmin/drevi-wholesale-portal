"use client";

import Link from "next/link";
import { Plus, Minus } from "lucide-react";
import { StockPill } from "@/components/StockPill";
import { ProductImage } from "@/components/ProductImage";
import { getStockState, qtyCap } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

// Reusable across buyer, exhibition, and admin. When `cartQty` > 0 the card
// renders a − / + stepper instead of the Add button. Staff flows pass
// enforceCaps={false}: stock caps become advisory and the stepper never locks.
export function ProductCard({
  product,
  showPrices = true,
  large = false,
  cartQty = 0,
  onChangeQty,
  detailHref,
  enforceCaps = true,
  onGoToCart,
  variantBar,
  onOpenDetail,
}: {
  product: WholesaleProduct;
  showPrices?: boolean;
  large?: boolean;
  cartQty?: number;
  onChangeQty?: (product: WholesaleProduct, qty: number) => void;
  detailHref?: string;
  enforceCaps?: boolean;
  onGoToCart?: () => void;
  variantBar?: React.ReactNode;
  // Opens a detail view where page navigation isn't available (exhibition).
  onOpenDetail?: (product: WholesaleProduct) => void;
}) {
  const state = getStockState(product);
  const canAdd = state !== "sold_out";
  const cap = qtyCap(product);
  const atCap = enforceCaps && cap != null && cartQty >= cap;
  const initialQty = product.min_order_qty ?? 1;

  const titleBlock = (
    <>
      <ProductImage product={product} large={large} />
      <div className={large ? "px-4 pt-4" : "px-3 pt-3"}>
        <div
          className="font-display"
          style={{ color: palette.black, fontSize: large ? 15 : 13, lineHeight: 1.25, fontWeight: 500, minHeight: large ? 38 : 32 }}
        >
          {product.title ?? product.sku}
        </div>
        <div className="font-body mt-0.5" style={{ color: palette.mutedGreige, fontSize: 9, letterSpacing: "0.1em" }}>
          {product.sku}
        </div>
      </div>
    </>
  );

  const padY = large ? "10px 0" : "9px 0";

  return (
    <div className="flex flex-col" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.06)" }}>
      {detailHref ? (
        <Link href={detailHref} className="block">{titleBlock}</Link>
      ) : onOpenDetail ? (
        <button type="button" onClick={() => onOpenDetail(product)} className="block w-full text-left" style={{ cursor: "pointer" }}>
          {titleBlock}
        </button>
      ) : (
        titleBlock
      )}

      <div className={large ? "px-4 pb-4" : "px-3 pb-3"}>
        <div className="mt-2.5">
          <StockPill product={product} compact={!large} />
        </div>

        {variantBar}

        <div className="mt-3 flex items-baseline justify-between gap-2">
          {showPrices ? (
            <div className="font-display" style={{ color: palette.black, fontSize: large ? 18 : 16, fontWeight: 600, letterSpacing: "0.01em" }}>
              {formatINR(product.wholesale_price)}
            </div>
          ) : (
            <div className="font-body" style={{ color: palette.mutedGreige, fontSize: 11, letterSpacing: "0.1em" }}>——</div>
          )}
        </div>

        {product.min_order_qty ? (
          <div className="font-body mt-1" style={{ color: palette.goldDeep, fontSize: 10, letterSpacing: "0.05em" }}>
            Minimum {product.min_order_qty} pieces
          </div>
        ) : null}

        {/* Add button OR stepper */}
        {cartQty > 0 && canAdd ? (
          <>
          <div
            className="mt-3 w-full grid items-center"
            style={{
              gridTemplateColumns: "1fr auto 1fr",
              background: palette.black,
              color: palette.ivory,
              fontFamily: "var(--font-montserrat), system-ui, sans-serif",
            }}
          >
            <button
              type="button"
              aria-label="Decrease"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChangeQty?.(product, cartQty - 1); }}
              className="flex items-center justify-center"
              style={{ padding: padY, color: palette.gold }}
            >
              <Minus size={14} strokeWidth={2.5} />
            </button>
            <span
              className="font-body"
              style={{ minWidth: 28, textAlign: "center", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
              aria-label={`In cart: ${cartQty}`}
            >
              {cartQty}
            </span>
            <button
              type="button"
              aria-label="Increase"
              disabled={atCap}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!atCap) onChangeQty?.(product, cartQty + 1); }}
              className="flex items-center justify-center disabled:opacity-40"
              style={{ padding: padY, color: palette.gold }}
            >
              <Plus size={14} strokeWidth={2.5} />
            </button>
          </div>
          {onGoToCart && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onGoToCart(); }}
              className="mt-1.5 w-full text-center font-body uppercase"
              style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.goldDeep, padding: "4px 0" }}
            >
              Go to cart →
            </button>
          )}
          </>
        ) : (
          <button
            type="button"
            disabled={!canAdd}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (canAdd) onChangeQty?.(product, initialQty); }}
            className="mt-3 w-full flex items-center justify-center gap-1.5 font-body uppercase transition-colors"
            style={{
              color: canAdd ? palette.ivory : "#AAA",
              background: canAdd ? palette.black : palette.soldBtn,
              fontSize: 10,
              letterSpacing: "0.2em",
              padding: padY,
              cursor: canAdd ? "pointer" : "not-allowed",
            }}
          >
            {canAdd ? (<><Plus size={11} strokeWidth={2.5} /> Add to Cart</>) : "Unavailable"}
          </button>
        )}
      </div>
    </div>
  );
}
