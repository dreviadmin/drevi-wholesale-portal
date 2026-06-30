"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Eye, EyeOff, ChevronLeft, Minus, Plus, UserPlus, Search, ShoppingBag } from "lucide-react";
import { ProductCard } from "@/components/ProductCard";
import { OfflineSync } from "@/components/OfflineSync";
import { captureBuyer, submitExhibitionOrder, endSession } from "../actions";
import { cacheProducts, enqueue } from "@/lib/offline";
import { getStockState, qtyCap } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

type Buyer = { id: string; business_name: string | null; owner_name: string | null; phone: string | null; city: string | null };
type Step = "buyer" | "catalog" | "cart" | "confirm";

const PREFERRED = ["Sarees", "Lehengas", "Indo-Western", "Co-ords", "Drape Skirts", "Jackets"];

export function ExhibitionWizard({
  session,
  products,
  buyers,
  stockAsOf,
}: {
  session: { id: string; event_name: string; ended: boolean };
  products: WholesaleProduct[];
  buyers: Buyer[];
  stockAsOf: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("buyer");
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [showPrices, setShowPrices] = useState(true);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [newBuyer, setNewBuyer] = useState(false);
  const [nb, setNb] = useState({
    business_name: "", owner_name: "", email: "", phone: "+91", city: "", gstin: "",
    address: "", transport_details: "", broker_details: "", other_details: "",
  });
  const [staffNote, setStaffNote] = useState("");
  const [buyerNote, setBuyerNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmInfo, setConfirmInfo] = useState<{ orderId: string; orderNumber: string } | null>(null);
  const [buyerClientRef, setBuyerClientRef] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  // Prefetch the catalog into IndexedDB so it survives going offline mid-session.
  useEffect(() => {
    cacheProducts(products).catch(() => {});
  }, [products]);

  const bySku = useMemo(() => new Map(products.map((p) => [p.sku, p])), [products]);
  const categories = useMemo(() => {
    const present = new Set(products.map((p) => p.category).filter((c): c is string => !!c));
    return ["All", ...PREFERRED.filter((c) => present.has(c)), ...Array.from(present).filter((c) => !PREFERRED.includes(c)).sort()];
  }, [products]);
  const filtered = useMemo(() => (category === "All" ? products : products.filter((p) => p.category === category)), [category, products]);
  const catalogFiltered = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((p) => (p.title?.toLowerCase().includes(q) ?? false) || p.sku.toLowerCase().includes(q));
  }, [filtered, catalogQuery]);
  const cartLines = Object.entries(cart).map(([sku, qty]) => ({ p: bySku.get(sku)!, qty })).filter((l) => l.p);
  const cartCount = cartLines.length;
  const subtotal = cartLines.reduce((s, l) => s + l.qty * l.p.wholesale_price, 0);
  const hasBlock = cartLines.some((l) => l.p.min_order_qty != null && l.qty < l.p.min_order_qty);

  const buyerMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buyers.slice(0, 8);
    return buyers.filter((b) => [b.business_name, b.owner_name, b.phone].some((v) => v?.toLowerCase().includes(q))).slice(0, 12);
  }, [buyers, query]);

  function setQty(sku: string, qty: number) {
    const p = bySku.get(sku);
    const cap = p ? qtyCap(p) : null;
    setCart((c) => {
      if (qty <= 0) { const next = { ...c }; delete next[sku]; return next; }
      return { ...c, [sku]: cap != null ? Math.min(qty, cap) : qty };
    });
  }
  function changeCartQty(p: WholesaleProduct, qty: number) { setQty(p.sku, qty); }

  function captureNew() {
    setError(null);
    start(async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const ref = crypto.randomUUID();
        await enqueue("capture", { clientRef: ref, form: nb });
        setBuyerClientRef(ref);
        setBuyer({ id: "", business_name: nb.business_name, owner_name: nb.owner_name, phone: nb.phone, city: nb.city });
        setNewBuyer(false);
        setStep("catalog");
        return;
      }
      const res = await captureBuyer(nb);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setBuyerClientRef(null);
      setBuyer({ id: res.id!, business_name: nb.business_name, owner_name: nb.owner_name, phone: nb.phone, city: nb.city });
      setNewBuyer(false);
      setStep("catalog");
    });
  }

  function submit() {
    if (!buyer || hasBlock) return;
    setError(null);
    const items = cartLines.map((l) => ({ sku: l.p.sku, qty: l.qty }));
    start(async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await enqueue("order", {
          sessionId: session.id, eventName: session.event_name,
          buyerId: buyerClientRef ? undefined : buyer.id, buyerClientRef: buyerClientRef ?? undefined,
          items, staffNote, buyerNote,
        });
        setConfirmInfo({ orderId: "", orderNumber: "Queued — will sync when back online" });
        setStep("confirm");
        return;
      }
      const res = await submitExhibitionOrder({
        sessionId: session.id, eventName: session.event_name, buyerId: buyer.id, items, staffNote, buyerNote,
      });
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setConfirmInfo({ orderId: res.orderId!, orderNumber: res.orderNumber ?? "" });
      setStep("confirm");
    });
  }

  function nextBuyer() {
    setBuyer(null); setBuyerClientRef(null); setCart({}); setStaffNote(""); setBuyerNote(""); setConfirmInfo(null); setQuery(""); setCatalogQuery(""); setStep("buyer");
  }

  function endSessionConfirmed() {
    if (!window.confirm("Are you sure you want to exit and end this session?")) return;
    endSession(session.id, session.event_name).then(() => router.push("/admin/exhibition"));
  }

  // ---------- Top bar ----------
  const topBar = (
    <div className="flex items-center justify-between px-4 md:px-6 py-3" style={{ background: palette.black, color: palette.ivory }}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-display" style={{ fontSize: 14, letterSpacing: "0.25em", fontWeight: 600 }}>DREVI · EXHIBITION</span>
        <span className="font-body truncate" style={{ fontSize: 10, letterSpacing: "0.1em", color: palette.champagne }}>{session.event_name}{buyer ? ` · ${buyer.business_name}` : ""}</span>
      </div>
      <div className="flex items-center gap-4">
        {step === "catalog" && (
          <button type="button" onClick={() => setShowPrices((v) => !v)} className="flex items-center gap-1.5 font-body uppercase" style={{ color: showPrices ? palette.gold : "#9A9485", fontSize: 10, letterSpacing: "0.15em" }}>
            {showPrices ? <Eye size={14} /> : <EyeOff size={14} />} Prices · {showPrices ? "On" : "Off"}
          </button>
        )}
        {(step === "catalog" || step === "cart") && (
          <button
            type="button"
            onClick={() => setStep("cart")}
            aria-label={`Cart (${cartCount})`}
            className="flex items-center gap-2 font-body uppercase"
            style={{
              background: cartCount > 0 ? palette.gold : "transparent",
              color: cartCount > 0 ? palette.black : palette.gold,
              border: `1px solid ${palette.gold}`,
              padding: "6px 14px",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.15em",
            }}
          >
            <ShoppingBag size={15} strokeWidth={2} /> Cart · {cartCount}
          </button>
        )}
        <button type="button" onClick={endSessionConfirmed} className="font-body uppercase" style={{ border: "1px solid rgba(255,255,255,0.3)", padding: "5px 12px", fontSize: 9, letterSpacing: "0.18em" }}>End Session</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen" style={{ background: palette.ivory }}>
      {topBar}

      {error && <div className="px-4 md:px-6 py-2 font-body" style={{ background: palette.crimsonSoft, color: palette.crimsonText, fontSize: 12 }}>{error}</div>}

      {/* E3 — buyer */}
      {step === "buyer" && (
        <div className="px-4 md:px-6 py-5 max-w-xl">
          <h2 className="font-display" style={{ fontSize: 18, fontWeight: 600 }}>Who is this order for?</h2>
          {!newBuyer ? (
            <>
              <div className="flex items-center gap-2 mt-4" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px" }}>
                <Search size={15} color={palette.mutedGreige} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search existing buyers" className="font-body bg-transparent outline-none w-full" style={{ fontSize: 13 }} />
              </div>
              <div className="mt-2">
                {buyerMatches.map((b) => (
                  <button key={b.id} type="button" onClick={() => { setBuyer(b); setStep("catalog"); }} className="w-full text-left py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
                    <div className="font-display" style={{ fontSize: 13, fontWeight: 600 }}>{b.business_name}</div>
                    <div className="font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>{[b.owner_name, b.city].filter(Boolean).join(" · ")}</div>
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setNewBuyer(true)} className="mt-4 flex items-center gap-2 font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>
                <UserPlus size={14} /> New Buyer
              </button>
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {([
                { k: "business_name", label: "business name" },
                { k: "owner_name", label: "owner name", req: true },
                { k: "email", label: "email" },
                { k: "phone", label: "phone", req: true },
                { k: "city", label: "city" },
                { k: "gstin", label: "GSTIN" },
                { k: "address", label: "address", area: true },
                { k: "transport_details", label: "transport", area: true },
                { k: "broker_details", label: "broker", area: true },
                { k: "other_details", label: "other", area: true },
              ] as const).map((f) => (
                <label key={f.k} className="flex flex-col gap-1">
                  <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>{f.label}{("req" in f && f.req) ? " *" : ""}</span>
                  {("area" in f && f.area) ? (
                    <textarea rows={2} value={nb[f.k]} onChange={(e) => setNb({ ...nb, [f.k]: e.target.value })} className="font-body bg-transparent outline-none resize-none" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 9px", fontSize: 13 }} />
                  ) : (
                    <input value={nb[f.k]} onChange={(e) => setNb({ ...nb, [f.k]: e.target.value })} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
                  )}
                </label>
              ))}
              <div className="flex gap-2 mt-1">
                <button type="button" onClick={() => setNewBuyer(false)} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>Back</button>
                <button type="button" onClick={captureNew} disabled={isPending} className="font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>{isPending ? "Saving…" : "Capture & Continue"}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* E4 — catalog */}
      {step === "catalog" && (
        <div className="px-4 md:px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
              {categories.map((c) => {
                const active = c === category;
                return <button key={c} type="button" onClick={() => setCategory(c)} className="font-body uppercase whitespace-nowrap" style={{ color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)", padding: "6px 12px", fontSize: 10, letterSpacing: "0.15em" }}>{c}</button>;
              })}
            </div>
            <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige, letterSpacing: "0.04em" }}>Stock as of {stockAsOf}</span>
          </div>
          <div className="mt-3 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px" }}>
            <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
            <input value={catalogQuery} onChange={(e) => setCatalogQuery(e.target.value)} placeholder="Search title or SKU" className="font-body bg-transparent outline-none w-full" style={{ fontSize: 12.5, color: palette.black }} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-4">
            {catalogFiltered.map((p) => (
              <ProductCard key={p.sku} product={p} showPrices={showPrices} cartQty={cart[p.sku] ?? 0} onChangeQty={changeCartQty} />
            ))}
          </div>
        </div>
      )}

      {/* E5 — cart */}
      {step === "cart" && (
        <div className="px-4 md:px-6 py-5 max-w-2xl">
          <button type="button" onClick={() => setStep("catalog")} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}><ChevronLeft size={14} /> Catalog</button>
          <h2 className="font-display mt-2" style={{ fontSize: 18, fontWeight: 600 }}>Cart · {buyer?.business_name}</h2>
          {cartLines.length === 0 ? (
            <p className="font-body mt-4" style={{ fontSize: 12, color: palette.mutedGreige }}>No items yet.</p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {cartLines.map((l) => {
                const cap = qtyCap(l.p);
                const belowMoq = l.p.min_order_qty != null && l.qty < l.p.min_order_qty;
                const state = getStockState(l.p);
                const img = l.p.image_urls?.[0];
                return (
                  <div key={l.p.sku} className="flex items-center gap-3 p-3" style={{ border: "1px solid rgba(26,26,26,0.08)" }}>
                    <div className="relative flex-shrink-0" style={{ width: 88, height: 110, background: palette.ivoryDeep }}>
                      {img && <Image src={img} alt={l.p.title ?? l.p.sku} fill sizes="88px" className="object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{l.p.title}</div>
                      <div className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>{l.p.sku}</div>
                      {state === "made_to_order" && <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep }}>Made to Order · {l.p.restock_days}d</div>}
                      {belowMoq && <div className="font-body mt-1" style={{ fontSize: 10, color: palette.crimsonText }}>Minimum {l.p.min_order_qty} pieces</div>}
                    </div>
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="flex items-center" style={{ border: "1px solid rgba(26,26,26,0.2)" }}>
                        <button type="button" onClick={() => setQty(l.p.sku, l.qty - 1)} className="px-2 py-1"><Minus size={12} /></button>
                        <span className="font-body" style={{ minWidth: 24, textAlign: "center", fontSize: 13 }}>{l.qty}</span>
                        <button type="button" onClick={() => setQty(l.p.sku, l.qty + 1)} disabled={cap != null && l.qty >= cap} className="px-2 py-1 disabled:opacity-40"><Plus size={12} /></button>
                      </div>
                      <span className="font-display" style={{ fontSize: 13, fontWeight: 600, minWidth: 64, textAlign: "right" }}>{formatINR(l.qty * l.p.wholesale_price)}</span>
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-between items-baseline mt-2">
                <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em" }}>Subtotal</span>
                <span className="font-display" style={{ fontSize: 18, fontWeight: 600 }}>{formatINR(subtotal)}</span>
              </div>
              <label className="flex flex-col gap-1 mt-2"><span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Staff note</span><input value={staffNote} onChange={(e) => setStaffNote(e.target.value)} className="font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12 }} /></label>
              <label className="flex flex-col gap-1"><span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Buyer note</span><input value={buyerNote} onChange={(e) => setBuyerNote(e.target.value)} className="font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12 }} /></label>
              <button type="button" onClick={submit} disabled={isPending || hasBlock} className="mt-2 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}>{isPending ? "Submitting…" : "Submit Order"}</button>
            </div>
          )}
        </div>
      )}

      {/* E6 — confirmation */}
      {step === "confirm" && confirmInfo && (
        <div className="px-4 md:px-6 py-10 max-w-md mx-auto text-center">
          <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.22em", color: palette.gold }}>Order Submitted</div>
          <div className="font-display mt-2" style={{ fontSize: 24, fontWeight: 600 }}>{confirmInfo.orderNumber}</div>
          <p className="font-body mt-3" style={{ fontSize: 12, color: palette.softBlack, lineHeight: 1.7 }}>
            {confirmInfo.orderId
              ? "The order summary PDF has been generated and sent to the buyer's WhatsApp (or available to download below)."
              : "Saved on this device. It will sync — and the PDF send will fire — automatically when you're back online."}
          </p>
          {confirmInfo.orderId && (
            <a href={`/api/orders/${confirmInfo.orderId}/pdf`} target="_blank" rel="noreferrer" className="inline-block mt-4 font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "10px 18px", color: palette.black }}>Download PDF</a>
          )}
          <div className="flex gap-2 justify-center mt-8">
            <button type="button" onClick={nextBuyer} className="font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 18px" }}>Next Buyer</button>
            <button type="button" onClick={endSessionConfirmed} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "11px 18px" }}>End Session</button>
          </div>
        </div>
      )}

      <OfflineSync />
    </div>
  );
}
