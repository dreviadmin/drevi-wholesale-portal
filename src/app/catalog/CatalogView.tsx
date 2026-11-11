"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, QrCode } from "lucide-react";
import { DreviHeader } from "@/components/DreviHeader";
import { FilterChips } from "@/components/FilterChips";
import { GroupedProductCard } from "@/components/GroupedProductCard";
import { QrScanner } from "@/components/QrScanner";
import { arrivedByBackOrForward } from "@/components/InAppHistory";
import { setQty as setCartQty } from "@/app/cart/actions";
import { baseSkuOf, groupByBase } from "@/lib/variants";
import { cartPieces } from "@/lib/cart-count";
import { CatalogCardSaves } from "@/lib/catalog-card-saves";
import { catalogFiltersFrom, catalogHref, savedScroll, scrollToRestore } from "@/lib/catalog-url";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";
import { toastDuration } from "@/lib/use-toast";

// One slot: the scroll of the catalog URL a product was last opened from.
const SCROLL_KEY = "drevi.catalog.scroll";

// Chips in the same order as the buyer home's category tree: the category
// with the most designs (SKU bases, i.e. cards) first, ties by name. One
// ordering rule on both screens, so a buyer who taps "Lehenga" second on the
// home page finds it second here too.
function orderedByDesigns(products: WholesaleProduct[], keyOf: (p: WholesaleProduct) => string | null): string[] {
  const bases = new Map<string, Set<string>>();
  for (const p of products) {
    const k = keyOf(p)?.trim();
    if (!k) continue;
    if (!bases.has(k)) bases.set(k, new Set());
    bases.get(k)!.add(baseSkuOf(p.sku));
  }
  return [...bases.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([k]) => k);
}

function buildCategories(products: WholesaleProduct[]): string[] {
  return ["All", ...orderedByDesigns(products, (p) => p.category)];
}

// Sub-categories of ONE category, only those with at least one design.
function buildSubCategories(products: WholesaleProduct[], category: string): string[] {
  if (category === "All") return [];
  return orderedByDesigns(products.filter((p) => p.category === category), (p) => p.sub_category);
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
  // Filters live in the URL (?cat, ?sub, ?q) so Back from a product lands on
  // the same chips and search, and the /home category links deep-link in.
  // Seeded from the URL on mount, which is already the right URL on a fresh
  // load and on Back alike, so the first paint is filtered.
  const searchParams = useSearchParams();
  const [initial] = useState(() => catalogFiltersFrom(searchParams));
  const [category, setCategory] = useState(initial.category);
  // Sub-category within `category`; null = every design in the category.
  const [sub, setSub] = useState<string | null>(initial.sub);
  const [query, setQuery] = useState(initial.query);
  // The search reaches the URL after a pause in typing; chips at once.
  const [urlQuery, setUrlQuery] = useState(initial.query);
  useEffect(() => {
    const t = setTimeout(() => setUrlQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  const [cart, setCart] = useState<Record<string, number>>(initialCartBySku);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scanner callbacks outlive renders — read the live cart via a ref.
  const cartRef = useRef(cart);
  cartRef.current = cart;

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), toastDuration(msg));
  }
  function setLine(sku: string, q: number) {
    setCart((c) => {
      const copy = { ...c };
      if (q === 0) delete copy[sku];
      else copy[sku] = q;
      return copy;
    });
  }

  // Card saves one at a time, and no address write or page change while one
  // is outstanding: Next 14.2 drops a queued server action when the router
  // navigates or history is written, so a chip tap mid-save used to lose a
  // tap without a word (Nov review; see src/lib/catalog-card-saves.ts).
  const [saves] = useState(
    () =>
      new CatalogCardSaves({
        save: async (sku, qty) => (await setCartQty(sku, qty)).qty,
        showLine: setLine,
        toast: showToast,
        // replaceState, not router.replace: no new history entry and no
        // server round trip. Next 14.2 keeps useSearchParams in step with it.
        replaceUrl: (href) => {
          if (href !== window.location.pathname + window.location.search) window.history.replaceState(null, "", href);
        },
        navigate: (href) => router.push(href),
        onBusyChange: setSaving,
      }),
  );
  useEffect(() => {
    saves.setActive(true);
    return () => {
      saves.setActive(false);
      saves.flush();
    };
  }, [saves]);

  function writeUrl(q: string) {
    const href = catalogHref({ category, sub, query: q });
    saves.writeUrl(href);
    return href;
  }
  // Not on mount, only once the buyer moves a filter. On mount the address
  // already says what is shown, and on a fresh load this effect runs before
  // Next installs its history patch (a parent's effects run after a child's):
  // an unpatched replaceState would wipe the router's state from this entry,
  // and Back to it would then change the address but not the page. A URL
  // that is not in catalogHref's form (%20 for a space, an extra param) is
  // tidied on the first filter change or card tap instead.
  const filtersMoved = useRef(false);
  useEffect(() => {
    if (!filtersMoved.current) {
      if (category === initial.category && sub === initial.sub && urlQuery === initial.query) return;
      filtersMoved.current = true;
    }
    writeUrl(urlQuery);
    // writeUrl reads category and sub, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, sub, urlQuery]);
  // Every link on the page (cards, the wordmark, the menu) waits while a
  // card save is outstanding, then goes. Opening a product also brings the
  // URL up to date with the live search (the pause may not be over) and
  // notes the scroll for the way Back.
  function onLinkClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a[href]");
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target && a.target !== "_self")) return;
    if (href.startsWith("/product/")) {
      const here = writeUrl(query);
      try { sessionStorage.setItem(SCROLL_KEY, savedScroll(here, window.scrollY)); } catch { /* private mode: no restore */ }
    }
    // Held: Link sees defaultPrevented and leaves it to saves.go.
    if (saves.holding) {
      e.preventDefault();
      saves.go(href);
    }
  }
  // Back to the same URL: put the scroll back once, then forget it.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(SCROLL_KEY);
      sessionStorage.removeItem(SCROLL_KEY);
    } catch { /* storage blocked */ }
    const y = scrollToRestore(raw, window.location.pathname + window.location.search, arrivedByBackOrForward());
    if (y != null) requestAnimationFrame(() => window.scrollTo(0, y));
  }, []);
  const categories = useMemo(() => buildCategories(products), [products]);
  const subCategories = useMemo(() => buildSubCategories(products, category), [products, category]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (sub && p.sub_category !== sub) return false;
      if (!q) return true;
      return (p.title?.toLowerCase().includes(q) ?? false) || p.sku.toLowerCase().includes(q);
    });
  }, [category, sub, query, products]);
  const groups = useMemo(() => groupByBase(filtered), [filtered]);

  // Pieces, like the badge on Home and the cart menu (Oct review).
  const cartCount = useMemo(() => cartPieces(Object.values(cart)), [cart]);

  // QR decode → add to cart (continuous: scanner stays open, returns feedback).
  function handleScan(text: string): { ok: boolean; message: string } {
    const sku = text.trim().toUpperCase();
    const product = products.find((p) => p.sku.toUpperCase() === sku);
    if (!product) return { ok: false, message: `SKU not found: ${text.trim()}` };
    const next = (cartRef.current[product.sku] ?? 0) + 1;
    changeQty(product, next);
    return { ok: true, message: `${product.title ?? product.sku} — ${next} in cart` };
  }

  function changeQty(product: WholesaleProduct, qty: number) {
    // The card's number moves at once. The save follows in turn; a clamp or a
    // failure puts the card to what the server holds, and "Added to cart" or
    // "no longer available" waits for the reply (CatalogCardSaves).
    const next = qty <= 0 ? 0 : qty;
    const before = cartRef.current[product.sku] ?? 0;
    setLine(product.sku, next);
    if (next === 0) showToast("Removed from cart");
    saves.change(product.sku, next, before);
  }

  return (
    <div onClickCapture={onLinkClick} className="min-h-screen flex flex-col" style={{ background: palette.ivory }}>
      <DreviHeader businessName={businessName} cartCount={cartCount} onCart={() => saves.go("/cart")} />
      <FilterChips categories={categories} active={category} onSelect={(c) => { setCategory(c); setSub(null); }} />
      {subCategories.length > 0 && (
        <FilterChips categories={["All", ...subCategories]} active={sub ?? "All"} onSelect={(s) => setSub(s === "All" ? null : s)} />
      )}

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
          <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 ${saving ? "opacity-95" : ""}`}>
            {groups.map((g) => (
              <GroupedProductCard
                key={g.base}
                variants={g.variants}
                cartBySku={cart}
                onChangeQty={changeQty}
                detailHrefFor={(sku) => `/product/${encodeURIComponent(sku)}`}
                onGoToCart={() => saves.go("/cart")}
                showStock={false}
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
          onGoToCart={() => { setScanning(false); saves.go("/cart"); }}
        />
      )}
    </div>
  );
}
