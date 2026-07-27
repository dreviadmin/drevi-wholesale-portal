"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ShoppingCart, ChevronRight, ScanLine, X, Bell, ImageOff } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import type { BuyerHomeData } from "@/lib/buyer-home";
import { addToCart } from "@/app/cart/actions";
import { notifyMe, dismissNotify } from "./actions";

// Buyer storefront home (§13). PRICING FIREWALL: list wholesale prices only —
// never a personalised discount, cost, or vendor field. Final pricing wording
// stays on the cart.

export function BuyerHome({ businessName, city, cartCount, data }: {
  businessName: string;
  city: string | null;
  cartCount: number;
  data: BuyerHomeData;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState<{ sku: string; known: boolean; title?: string | null; thumb?: string | null; message?: string; actions: { key: string; label: string; href?: string }[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    if (!sku) return { ok: false, message: "Empty code" };
    fetch(`/api/scan/resolve?sku=${encodeURIComponent(sku)}`)
      .then((r) => r.json())
      .then((d) => { setScanned(d); setScanOpen(false); })
      .catch(() => flash("Could not look that up"));
    return { ok: true, message: sku };
  }

  function add(sku: string) {
    startTransition(async () => {
      const res = await addToCart(sku, 1);
      flash(res.ok ? "Added to cart" : res.message ?? "Could not add");
      if (res.ok) router.refresh();
    });
  }

  const stockLabel = (qty: number, restockable: boolean) =>
    qty > 0 ? { text: qty <= 5 ? `Limited · ${qty} left` : "In stock", bg: qty <= 5 ? "rgba(239,159,39,.92)" : "rgba(93,202,165,.92)", fg: qty <= 5 ? "#412402" : "#04342C" }
            : restockable ? { text: "Made to order", bg: "rgba(90,122,154,.92)", fg: "#fff" }
            : { text: "Sold out", bg: "rgba(201,123,123,.92)", fg: "#fff" };

  return (
    <div className="min-h-screen pb-24" style={{ background: palette.pageBg }}>
      {/* Brand bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between px-4 py-3" style={{ background: palette.black }}>
        <div>
          <div className="font-display" style={{ fontSize: 14, letterSpacing: "0.28em", color: palette.ivory, fontWeight: 600 }}>
            DREVI <span className="font-body" style={{ fontSize: 8, letterSpacing: "0.2em", color: palette.gold }}>WHOLESALE</span>
          </div>
          <div className="font-body mt-0.5" style={{ fontSize: 10.5, color: palette.champagne }}>
            {businessName}{city ? ` · ${city}` : ""}
          </div>
        </div>
        <Link href="/cart" className="relative" aria-label="Cart">
          <ShoppingCart size={19} color={palette.ivory} />
          {cartCount > 0 && (
            <span className="absolute -top-1.5 -right-2 flex items-center justify-center rounded-full font-body" style={{ minWidth: 16, height: 16, fontSize: 9, fontWeight: 700, background: palette.gold, color: palette.black }}>
              {cartCount}
            </span>
          )}
        </Link>
      </div>

      <div className="px-4 py-4 max-w-3xl mx-auto">
        {/* Active order strip */}
        {data.activeOrder && (
          <Link href={`/order/${data.activeOrder.id}`} className="flex items-center gap-3 p-3.5 mb-4" style={{ background: "#fff", border: "1px solid #cfdae4", borderRadius: 12 }}>
            <span className="min-w-0 flex-1">
              <span className="font-body block" style={{ fontSize: 13, color: palette.black, fontWeight: 500 }}>
                Order {data.activeOrder.orderNumber} {data.activeOrder.status === "confirmed" ? "confirmed" : "received"}
              </span>
              <span className="font-body block mt-0.5" style={{ fontSize: 11, color: palette.mutedGreige }}>
                {data.activeOrder.pieces} pieces · view invoice
              </span>
            </span>
            <ChevronRight size={15} color={palette.mutedGreige} />
          </Link>
        )}

        {/* Back in stock */}
        {data.backInStock.length > 0 && (
          <div className="mb-4 p-3.5" style={{ background: "#DFF0E4", borderRadius: 12 }}>
            <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: "#1F6B45", fontWeight: 600 }}>Back in stock</div>
            <div className="flex gap-2 mt-2 overflow-x-auto">
              {data.backInStock.map((b) => (
                <div key={b.sku} className="flex-shrink-0" style={{ width: 92 }}>
                  <Link href={`/product/${encodeURIComponent(b.sku)}`}>
                    {b.imageUrl ? (
                      <Image src={b.imageUrl} alt={b.title ?? b.sku} width={92} height={115} className="object-cover" unoptimized />
                    ) : (
                      <div className="flex items-center justify-center" style={{ width: 92, height: 115, background: palette.ivoryDeep }}><ImageOff size={14} color={palette.mutedGreige} /></div>
                    )}
                  </Link>
                  <button type="button" onClick={() => startTransition(async () => { await dismissNotify(b.sku); router.refresh(); })} className="font-body uppercase mt-1" style={{ fontSize: 7.5, letterSpacing: "0.1em", color: "#1F6B45" }}>
                    Got it
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reorder your usuals */}
        {data.reorder.length > 0 && (
          <>
            <div className="flex items-baseline justify-between">
              <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Reorder your usuals</span>
              <Link href="/catalog" className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>See all</Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mt-2">
              {data.reorder.map((r) => {
                const badge = stockLabel(r.currentQty, r.restockable);
                const soldOut = r.currentQty <= 0 && !r.restockable;
                return (
                  <div key={r.sku} style={{ background: "#fff", border: "1px solid rgba(26,26,26,0.08)" }}>
                    <Link href={`/product/${encodeURIComponent(r.sku)}`} className="block relative">
                      {r.imageUrl ? (
                        <Image src={r.imageUrl} alt={r.title ?? r.sku} width={220} height={275} className="w-full object-cover" style={{ aspectRatio: "4/5" }} unoptimized />
                      ) : (
                        <div className="flex items-center justify-center w-full" style={{ aspectRatio: "4/5", background: palette.ivoryDeep }}><ImageOff size={16} color={palette.mutedGreige} /></div>
                      )}
                      <span className="absolute top-1.5 left-1.5 font-body px-1.5 py-0.5" style={{ fontSize: 8, fontWeight: 600, background: badge.bg, color: badge.fg }}>{badge.text}</span>
                    </Link>
                    <div className="p-2">
                      <div className="font-body truncate" style={{ fontSize: 11.5, color: palette.black }}>{r.title ?? r.sku}</div>
                      <div className="font-display mt-0.5" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>
                        {formatINR(r.wholesalePrice)} <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>/pc</span>
                      </div>
                      <div className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
                        {r.minOrderQty ? `MOQ ${r.minOrderQty} · ` : ""}you took {r.pieces} pc
                      </div>
                      {soldOut ? (
                        <button type="button" disabled={pending} onClick={() => startTransition(async () => { const res = await notifyMe(r.sku); flash(res.ok ? "We'll tell you when it's back" : res.error ?? "Failed"); router.refresh(); })} className="w-full mt-1.5 flex items-center justify-center gap-1 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", border: `1px solid ${palette.black}`, color: palette.black, padding: "7px 0" }}>
                          <Bell size={10} /> Notify me
                        </button>
                      ) : (
                        <button type="button" disabled={pending} onClick={() => add(r.sku)} className="w-full mt-1.5 font-body uppercase disabled:opacity-40" style={{ fontSize: 8.5, letterSpacing: "0.1em", background: palette.black, color: palette.gold, padding: "7px 0" }}>
                          Add to cart
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* New this week */}
        {data.newThisWeek.length > 0 && (
          <>
            <div className="font-body uppercase mt-6" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>New this week</div>
            <div className="flex gap-2.5 mt-2 overflow-x-auto pb-1">
              {data.newThisWeek.map((p) => (
                <Link key={p.sku} href={`/product/${encodeURIComponent(p.sku)}`} className="flex-shrink-0" style={{ width: 132, background: "#fff", border: "1px solid rgba(26,26,26,0.08)" }}>
                  {(p.image_urls as string[] | null)?.[0] ? (
                    <Image src={(p.image_urls as string[])[0]} alt={p.title ?? p.sku} width={132} height={165} className="object-cover" unoptimized />
                  ) : (
                    <div className="flex items-center justify-center" style={{ width: 132, height: 165, background: palette.ivoryDeep }}><ImageOff size={14} color={palette.mutedGreige} /></div>
                  )}
                  <div className="p-2">
                    <div className="font-body truncate" style={{ fontSize: 10.5, color: palette.black }}>{p.title ?? p.sku}</div>
                    <div className="font-display" style={{ fontSize: 12, fontWeight: 600, color: palette.black }}>{formatINR(p.wholesale_price)}</div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        {/* Categories */}
        {data.categories.length > 0 && (
          <>
            <div className="font-body uppercase mt-6" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Shop by category</div>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {data.categories.map((c) => (
                <Link key={c} href={`/catalog?cat=${encodeURIComponent(c)}`} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.1em", padding: "8px 12px", background: "#fff", border: "1px solid rgba(26,26,26,0.12)", color: palette.softBlack }}>
                  {c}
                </Link>
              ))}
            </div>
          </>
        )}

        {data.reorder.length === 0 && data.newThisWeek.length === 0 && (
          <Link href="/catalog" className="block text-center font-body uppercase mt-8" style={{ fontSize: 10.5, letterSpacing: "0.18em", background: palette.black, color: palette.gold, padding: "14px 0" }}>
            Browse the catalog
          </Link>
        )}
      </div>

      {/* Buyer scan FAB */}
      <button type="button" onClick={() => { setScanned(null); setScanOpen(true); }} aria-label="Scan a tag" className="fixed rounded-full flex items-center justify-center z-40" style={{ right: 18, bottom: 22, width: 56, height: 56, background: palette.gold, boxShadow: "0 4px 16px rgba(196,163,90,0.55)" }}>
        <ScanLine size={23} strokeWidth={2.2} color={palette.black} />
      </button>

      {(scanOpen || scanned) && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center" style={{ background: "rgba(20,20,20,0.55)" }} onClick={() => { setScanOpen(false); setScanned(null); }}>
          <div className="w-full md:w-[420px] max-h-modal overflow-y-auto p-5" style={{ background: palette.ivory, borderRadius: "14px 14px 0 0" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.2em", color: palette.mutedGreige }}>Scan a tag</span>
              <button type="button" onClick={() => { setScanOpen(false); setScanned(null); }} aria-label="Close"><X size={16} color={palette.softBlack} /></button>
            </div>
            {scanOpen && <QrScanner onScan={handleScan} onClose={() => setScanOpen(false)} />}
            {scanned && (
              <div>
                <div className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: palette.black }}>{scanned.sku}</div>
                <div className="font-body mt-0.5" style={{ fontSize: 12, color: palette.softBlack }}>
                  {scanned.known ? scanned.title ?? "—" : scanned.message ?? "Not available on the wholesale portal."}
                </div>
                <div className="flex flex-col mt-3">
                  {scanned.actions.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      onClick={() => {
                        if (a.key === "add_to_cart") { add(scanned.sku); setScanned(null); return; }
                        if (a.href) router.push(a.href);
                      }}
                      className="text-left font-body"
                      style={{ fontSize: 13.5, color: palette.black, padding: "13px 2px", borderBottom: "1px solid rgba(26,26,26,0.06)" }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => { setScanned(null); setScanOpen(true); }} className="mt-4 w-full font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.18em", border: `1px solid ${palette.black}`, color: palette.black, padding: "11px 0" }}>
                  Scan another
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>{toast}</div>
      )}
    </div>
  );
}
