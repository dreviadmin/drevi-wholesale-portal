"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, QrCode } from "lucide-react";
import { DreviHeader } from "@/components/DreviHeader";
import { FilterChips } from "@/components/FilterChips";
import { GroupedProductCard } from "@/components/GroupedProductCard";
import { QrScanner } from "@/components/QrScanner";
import { setQty as setCartQty } from "@/app/cart/actions";
import { qtyCap } from "@/lib/stock";
import { groupByBase } from "@/lib/variants";
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
  initialCartBySku,
}: {
  businessName: string;
  products: WholesaleProduct[];
  initialCartBySku: Record<string, number>;
}) {
  const router = useRouter();
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, number>>(initialCartBySku);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scanner callbacks outlive renders — read the live cart via a ref.
  const cartRef = useRef(cart);
  cartRef.current = cart;

  const categories = useMemo(() => buildCategories(products), [products]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (!q) return true;
      return (p.title?.toLowerCase().includes(q) ?? false) || p.sku.toLowerCase().includes(q);
    });
  }, [category, query, products]);
  const groups = useMemo(() => groupByBase(filtered), [filtered]);

  const cartCount = useMemo(() => Object.values(cart).filter((q) => q > 0).length, [cart]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  // QR decode → add to cart (continuous: scanner stays open, returns feedback).
  function handleScan(text: string): { ok: boolean; message: string } {
    const sku = text.trim().toUpperCase();
    const product = products.find((p) => p.sku.toUpperCase() === sku);
    if (!product) return { ok: false, message: `SKU not found: ${text.trim()}` };
    const current = cartRef.current[product.sku] ?? 0;
    const next = current === 0 ? (product.min_order_qty ?? 1) : current + 1;
    changeQty(product, next);
    return { ok: true, message: `${product.title ?? product.sku} — ${next} in cart` };
  }

  function changeQty(product: WholesaleProduct, qty: number) {
    // Optimistic update — server clamps and returns the canonical qty.
    const cap = qtyCap(product);
    const desired = cap != null ? Math.min(qty, cap) : qty;
    const next = desired <= 0 ? 0 : desired;
    setCart((c) => {
      const copy = { ...c };
      if (next === 0) delete copy[product.sku];
      else copy[product.sku] = next;
      return copy;
    });
    if (next === 0) showToast("Removed from cart");
    else if (!cart[product.sku]) showToast("Added to cart");
    startTransition(async () => {
      const res = await setCartQty(product.sku, next);
      // Sync to authoritative qty (in case the server clamped further).
      setCart((c) => {
        const copy = { ...c };
        if (res.qty === 0) delete copy[product.sku];
        else copy[product.sku] = res.qty;
        return copy;
      });
    });
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: palette.ivory }}>
      <DreviHeader businessName={businessName} cartCount={cartCount} onCart={() => router.push("/cart")} />
      <FilterChips categories={categories} active={category} onSelect={setCategory} />

      {/* Search + scan */}
      <div className="px-4 py-3" style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.05)" }}>
        <div className="flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px" }}>
          <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or SKU"
            className="font-body bg-transparent outline-none w-full"
            style={{ fontSize: 12.5, color: palette.black }}
          />
          <button
            type="button"
            onClick={() => setScanning(true)}
            aria-label="Scan QR"
            className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
            style={{ color: palette.goldDeep, fontSize: 9, letterSpacing: "0.14em" }}
          >
            <QrCode size={17} strokeWidth={1.8} /> Scan
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 py-4">
        {products.length === 0 ? (
          <div className="text-center py-20 font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em", lineHeight: 1.8 }}>
            No products are available yet.
            <br />
            New pieces appear here as they&apos;re published.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em" }}>
            Nothing matches.
          </div>
        ) : (
          <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 ${isPending ? "opacity-95" : ""}`}>
            {groups.map((g) => (
              <GroupedProductCard
                key={g.base}
                variants={g.variants}
                cartBySku={cart}
                onChangeQty={changeQty}
                detailHrefFor={(sku) => `/product/${encodeURIComponent(sku)}`}
                onGoToCart={() => router.push("/cart")}
              />
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
          style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px", boxShadow: "0 8px 30px rgba(26,26,26,0.3)", zIndex: 60 }}
        >
          {toast}
        </div>
      )}

      {scanning && (
        <QrScanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
          onGoToCart={() => { setScanning(false); router.push("/cart"); }}
        />
      )}
    </div>
  );
}
