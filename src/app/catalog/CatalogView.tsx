"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DreviHeader } from "@/components/DreviHeader";
import { FilterChips } from "@/components/FilterChips";
import { ProductCard } from "@/components/ProductCard";
import { addToCart } from "@/app/cart/actions";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

// Preferred chip order (prototype); unknown categories are appended.
const PREFERRED = ["Sarees", "Lehengas", "Indo-Western", "Co-ords", "Drape Skirts", "Jackets"];

function buildCategories(products: WholesaleProduct[]): string[] {
  const present = new Set(products.map((p) => p.category).filter((c): c is string => !!c));
  const ordered = PREFERRED.filter((c) => present.has(c));
  const extras = Array.from(present).filter((c) => !PREFERRED.includes(c)).sort();
  return ["All", ...ordered, ...extras];
}

export function CatalogView({
  businessName,
  products,
  initialCartCount,
}: {
  businessName: string;
  products: WholesaleProduct[];
  initialCartCount: number;
}) {
  const router = useRouter();
  const [category, setCategory] = useState("All");
  const [toast, setToast] = useState<string | null>(null);
  const [count, setCount] = useState(initialCartCount);
  const [isPending, startTransition] = useTransition();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const categories = useMemo(() => buildCategories(products), [products]);
  const filtered = useMemo(
    () => (category === "All" ? products : products.filter((p) => p.category === category)),
    [category, products],
  );

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  function handleAdd(product: WholesaleProduct) {
    startTransition(async () => {
      const res = await addToCart(product.sku, product.min_order_qty ?? 1);
      if (res.ok) {
        setCount(res.count);
        showToast("Added to cart");
      } else {
        showToast(res.message ?? "Could not add to cart");
      }
    });
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: palette.ivory }}>
      <DreviHeader businessName={businessName} cartCount={count} onCart={() => router.push("/cart")} />
      <FilterChips categories={categories} active={category} onSelect={setCategory} />

      <div className="flex-1 px-4 py-4">
        {products.length === 0 ? (
          <div className="text-center py-20 font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em", lineHeight: 1.8 }}>
            No products are available yet.
            <br />
            New pieces appear here as they&apos;re published.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em" }}>
            Nothing in {category} right now.
          </div>
        ) : (
          <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 ${isPending ? "opacity-90" : ""}`}>
            {filtered.map((p) => (
              <ProductCard key={p.sku} product={p} onAdd={handleAdd} detailHref={`/product/${encodeURIComponent(p.sku)}`} />
            ))}
          </div>
        )}

        <div className="text-center py-8 font-display" style={{ color: palette.mutedGreige, fontSize: 11, letterSpacing: "0.3em" }}>
          ── DREAM FORWARD ──
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
