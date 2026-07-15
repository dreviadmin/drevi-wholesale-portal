"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { GroupedProductCard } from "@/components/GroupedProductCard";
import { ProductQuickView } from "@/components/ProductQuickView";
import { groupByBase } from "@/lib/variants";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

const PREFERRED = ["Lehenga", "Saree", "Indo-Western Set", "Suit Set", "Separates"];

export function StaffCatalogView({ products }: { products: WholesaleProduct[] }) {
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<WholesaleProduct | null>(null);

  const categories = useMemo(() => {
    const present = new Set(products.map((p) => p.category).filter((c): c is string => !!c));
    return ["All", ...PREFERRED.filter((c) => present.has(c)), ...Array.from(present).filter((c) => !PREFERRED.includes(c)).sort()];
  }, [products]);

  const filtered = useMemo(() => {
    let list = category === "All" ? products : products.filter((p) => p.category === category);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => (p.title?.toLowerCase().includes(q) ?? false) || p.sku.toLowerCase().includes(q) || (p.color?.toLowerCase().includes(q) ?? false));
    return list;
  }, [products, category, query]);

  const groups = useMemo(() => groupByBase(filtered), [filtered]);

  return (
    <div className="px-4 md:px-6 py-5">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Catalog</h1>
      <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
        {products.length} products · browse and search — tap any outfit for details.
      </p>

      <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-4">
        {categories.map((c) => {
          const active = c === category;
          return (
            <button key={c} type="button" onClick={() => setCategory(c)} className="font-body uppercase whitespace-nowrap" style={{ color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)", padding: "6px 12px", fontSize: 10, letterSpacing: "0.15em" }}>
              {c}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px" }}>
        <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, SKU or colour"
          className="font-body bg-transparent outline-none w-full"
          style={{ fontSize: 12.5, color: palette.black }}
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <X size={14} color={palette.mutedGreige} />
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="font-body mt-6" style={{ fontSize: 12, color: palette.mutedGreige }}>No designs match{query.trim() ? ` “${query.trim()}”` : ""}.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-4">
          {groups.map((g) => (
            <GroupedProductCard
              key={g.base}
              variants={g.variants}
              cartBySku={{}}
              onChangeQty={() => {}}
              readOnly
              onOpenDetail={setDetail}
            />
          ))}
        </div>
      )}

      {detail && <ProductQuickView product={detail} onClose={() => setDetail(null)} readOnly />}
    </div>
  );
}
