"use client";

import { Plus } from "lucide-react";
import { StockPill } from "@/components/StockPill";
import { ProductImage } from "@/components/ProductImage";
import { getStockState } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

// Reusable across buyer, exhibition, and admin. Ported from the prototype.
export function ProductCard({
  product,
  showPrices = true,
  large = false,
  onAdd,
}: {
  product: WholesaleProduct;
  showPrices?: boolean;
  large?: boolean;
  onAdd?: (product: WholesaleProduct) => void;
}) {
  const canAdd = getStockState(product) !== "sold_out";

  return (
    <div className="flex flex-col" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.06)" }}>
      <ProductImage product={product} large={large} />

      <div className={large ? "px-4 pt-4 pb-4" : "px-3 pt-3 pb-3"}>
        <div
          className="font-display"
          style={{ color: palette.black, fontSize: large ? 15 : 13, lineHeight: 1.25, fontWeight: 500, minHeight: large ? 38 : 32 }}
        >
          {product.title ?? product.sku}
        </div>

        <div className="font-body mt-0.5" style={{ color: palette.mutedGreige, fontSize: 9, letterSpacing: "0.1em" }}>
          {product.sku}
        </div>

        <div className="mt-2.5">
          <StockPill product={product} compact={!large} />
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-2">
          {showPrices ? (
            <div className="font-display" style={{ color: palette.black, fontSize: large ? 18 : 16, fontWeight: 600, letterSpacing: "0.01em" }}>
              {formatINR(product.wholesale_price)}
            </div>
          ) : (
            <div className="font-body" style={{ color: palette.mutedGreige, fontSize: 11, letterSpacing: "0.1em" }}>
              ——
            </div>
          )}
        </div>

        {product.min_order_qty ? (
          <div className="font-body mt-1" style={{ color: palette.goldDeep, fontSize: 10, letterSpacing: "0.05em" }}>
            Minimum {product.min_order_qty} pieces
          </div>
        ) : null}

        <button
          type="button"
          disabled={!canAdd}
          onClick={() => canAdd && onAdd?.(product)}
          className="mt-3 w-full flex items-center justify-center gap-1.5 font-body uppercase transition-colors"
          style={{
            color: canAdd ? palette.ivory : "#AAA",
            background: canAdd ? palette.black : palette.soldBtn,
            fontSize: 10,
            letterSpacing: "0.2em",
            padding: large ? "10px 0" : "9px 0",
            cursor: canAdd ? "pointer" : "not-allowed",
          }}
        >
          {canAdd ? (
            <>
              <Plus size={11} strokeWidth={2.5} /> Add to Cart
            </>
          ) : (
            "Unavailable"
          )}
        </button>
      </div>
    </div>
  );
}
