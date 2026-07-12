"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Eye, EyeOff, ChevronLeft, Minus, Plus, UserPlus, Search, ShoppingBag, QrCode, Share2, MessageCircle, X } from "lucide-react";
import { GroupedProductCard } from "@/components/GroupedProductCard";
import { PhoneInput } from "@/components/PhoneInput";
import { ProductQuickView } from "@/components/ProductQuickView";
import { QrScanner } from "@/components/QrScanner";
import { groupByBase } from "@/lib/variants";
import { OfflineSync } from "@/components/OfflineSync";
import { captureBuyer, submitExhibitionOrder, endSession, updateBuyerContact, uploadCustomItemPhoto } from "../actions";
import { uploadBuyerCard } from "@/app/admin/buyers/actions";
import { buildVCard, downloadVCard } from "@/lib/share";
import { cacheProducts, enqueue, updateQueuedCaptureForm } from "@/lib/offline";
import { uuid } from "@/lib/uuid";
import { getStockState, qtyCap } from "@/lib/stock";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { WholesaleProduct, SessionType, TaxMode, DiscountType } from "@/lib/types";

type Buyer = { id: string; business_name: string | null; owner_name: string | null; phone: string | null; city: string | null; status?: string };
type Step = "buyer" | "catalog" | "cart" | "confirm";

const PREFERRED = ["Sarees", "Lehengas", "Indo-Western", "Co-ords", "Drape Skirts", "Jackets"];
const GST_SLABS = [5, 12, 18];
const PAY_METHODS = ["Cash", "UPI", "Bank", "Other"];

export function ExhibitionWizard({
  session,
  products,
  buyers,
  stockAsOf,
}: {
  session: { id: string; event_name: string; ended: boolean; type: SessionType };
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
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [detailProduct, setDetailProduct] = useState<WholesaleProduct | null>(null);
  // Scanner callbacks outlive renders — read the live cart via a ref.
  const cartScanRef = useRef(cart);
  cartScanRef.current = cart;
  // Monotonic id source for custom items — never reuses a key after removal
  // (length-based ids could collide with a surviving line and edit both at once).
  const customSeqRef = useRef(0);
  // Stable idempotency key for the current order. Survives a failed retry and an
  // offline replay so the buyer is never billed twice; reset per next buyer.
  const orderRefRef = useRef<string | null>(null);
  // Same, for an online buyer capture (stable across a timeout-retry).
  const captureRefRef = useRef<string | null>(null);
  const [newBuyer, setNewBuyer] = useState(false);
  const NB_EMPTY = {
    business_name: "", owner_name: "", email: "", phone: "", city: "", gstin: "",
    address: "", transport_details: "", broker_details: "", other_details: "",
  };
  const [nb, setNb] = useState(NB_EMPTY);
  const [cardFile, setCardFile] = useState<File | null>(null);

  // Draft autosave — a half-captured buyer survives closing the tablet app
  // mid-conversation. Cleared once the capture succeeds.
  const NB_DRAFT_KEY = "drevi:draft:exh-buyer";
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NB_DRAFT_KEY);
      if (raw) setNb({ ...NB_EMPTY, ...JSON.parse(raw) });
    } catch { /* corrupt draft — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const hasContent = Object.values(nb).some((v) => typeof v === "string" && v.trim() !== "");
    try {
      if (hasContent) localStorage.setItem(NB_DRAFT_KEY, JSON.stringify(nb));
      else localStorage.removeItem(NB_DRAFT_KEY);
    } catch { /* storage full/blocked — non-fatal */ }
  }, [nb]);
  const [staffNote, setStaffNote] = useState("");
  const [buyerNote, setBuyerNote] = useState("");
  // Tax + payment (recorded at finalise)
  const [taxMode, setTaxMode] = useState<TaxMode>("none");
  const [taxRate, setTaxRate] = useState<number>(5);
  const [customRate, setCustomRate] = useState<string>("");
  const [advance, setAdvance] = useState<string>("");
  const [payMethod, setPayMethod] = useState<string>("Cash");
  const [payNote, setPayNote] = useState<string>("");
  // Billing adjustments: per-line price overrides + order discount
  const [priceOverrides, setPriceOverrides] = useState<Record<string, string>>({});
  const [discountType, setDiscountType] = useState<DiscountType | "none">("none");
  const [discountValue, setDiscountValue] = useState<string>("");
  // GST bill-split: bill one piece as N cheaper units (sku → factor, 1 = off).
  // The invoice shows qty×N at price/N; actual_qty keeps the truth on record.
  const [splitFactors, setSplitFactors] = useState<Record<string, number>>({});
  // Pieces not (yet) on the portal, keyed by a synthetic CUSTOM-n sku. Qty,
  // price overrides and GST splits reuse the normal per-sku machinery.
  const [customItems, setCustomItems] = useState<Record<string, { title: string; price: number; image?: string | null }>>({});
  const [customForm, setCustomForm] = useState<{ open: boolean; name: string; price: string; file: File | null }>({ open: false, name: "", price: "", file: null });
  const [customUploading, setCustomUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmInfo, setConfirmInfo] = useState<{ orderId: string; orderNumber: string; pdfUrl?: string } | null>(null);
  const [buyerClientRef, setBuyerClientRef] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  // Prefetch the catalog into IndexedDB so it survives going offline mid-session.
  useEffect(() => {
    cacheProducts(products).catch(() => {});
  }, [products]);

  // --- In-progress order autosave -------------------------------------------
  // The whole cart lives in volatile React state, so an accidental back-swipe or
  // refresh on a tablet mid-order would wipe a 40-line cart. Snapshot the
  // working order to localStorage (keyed by session) on every change, restore it
  // on mount, and clear it once the order is submitted.
  const CART_DRAFT_KEY = `drevi:wizard:${session.id}`;
  const PARKED_KEY = `drevi:wizard:${session.id}:parked`;
  const cartRestored = useRef(false);

  // Orders "on hold": a buyer backed out mid-checkout or two buyers are being
  // served at once. Each entry is a full working-order snapshot (same shape as
  // the autosave draft) that can be resumed with one tap.
  interface ParkedOrder {
    id: string;
    parkedAt: number;
    buyer: NonNullable<typeof buyer>;
    buyerClientRef: string | null;
    cart: Record<string, number>;
    priceOverrides: Record<string, string>;
    splitFactors: Record<string, number>;
    customItems: Record<string, { title: string; price: number; image?: string | null }>;
    taxMode: TaxMode;
    taxRate: number;
    customRate: string;
    discountType: DiscountType | "none";
    discountValue: string;
    advance: string;
    payMethod: string;
    payNote: string;
    staffNote: string;
    buyerNote: string;
    orderRef: string | null;
  }
  const [parked, setParked] = useState<ParkedOrder[]>([]);

  // Load the full working-order state from a snapshot (autosave draft or a
  // parked order). Callers decide the step.
  function loadSnapshot(d: Partial<ParkedOrder> & { buyer?: ParkedOrder["buyer"] }) {
    setBuyer(d.buyer ?? null); setBuyerClientRef(d.buyerClientRef ?? null);
    setCart(d.cart ?? {}); setPriceOverrides(d.priceOverrides ?? {}); setSplitFactors(d.splitFactors ?? {});
    setCustomItems(d.customItems ?? {});
    setTaxMode(d.taxMode ?? "none"); setTaxRate(d.taxRate ?? 5); setCustomRate(d.customRate ?? "");
    setDiscountType(d.discountType ?? "none"); setDiscountValue(d.discountValue ?? "");
    setAdvance(d.advance ?? ""); setPayMethod(d.payMethod ?? "Cash"); setPayNote(d.payNote ?? "");
    setStaffNote(d.staffNote ?? ""); setBuyerNote(d.buyerNote ?? "");
    setConfirmInfo(null);
    orderRefRef.current = d.orderRef ?? null;
    // keep the custom-item id counter ahead of any restored keys
    const maxCustom = Object.keys(d.customItems ?? {}).reduce((m: number, k: string) => Math.max(m, Number(k.split("-")[1]) || 0), 0);
    customSeqRef.current = Math.max(customSeqRef.current, maxCustom);
  }

  function snapshotCurrent(): ParkedOrder | null {
    if (!buyer) return null;
    return {
      id: uuid(), parkedAt: Date.now(),
      buyer, buyerClientRef, cart, priceOverrides, splitFactors, customItems,
      taxMode, taxRate, customRate, discountType, discountValue,
      advance, payMethod, payNote, staffNote, buyerNote,
      orderRef: orderRefRef.current,
    };
  }

  useEffect(() => {
    if (cartRestored.current) return;
    cartRestored.current = true;
    try {
      const rawParked = localStorage.getItem(PARKED_KEY);
      if (rawParked) {
        const list = JSON.parse(rawParked);
        if (Array.isArray(list)) setParked(list.filter((p) => p && p.buyer && p.cart));
      }
    } catch { /* corrupt parked list — ignore */ }
    try {
      const raw = localStorage.getItem(CART_DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || !d.buyer || !d.cart || Object.keys(d.cart).length === 0) return;
      loadSnapshot(d);
      setStep(d.step === "cart" ? "cart" : "catalog");
    } catch { /* corrupt draft — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the on-hold list per session.
  useEffect(() => {
    try {
      if (parked.length > 0) localStorage.setItem(PARKED_KEY, JSON.stringify(parked));
      else localStorage.removeItem(PARKED_KEY);
    } catch { /* storage blocked — non-fatal */ }
  }, [PARKED_KEY, parked]);

  useEffect(() => {
    // Persist only an active, non-empty order; clear otherwise (incl. post-submit).
    const active = !!buyer && (step === "catalog" || step === "cart") && !confirmInfo;
    const hasItems = Object.keys(cart).length > 0;
    try {
      if (active && hasItems) {
        localStorage.setItem(CART_DRAFT_KEY, JSON.stringify({
          buyer, buyerClientRef, cart, priceOverrides, splitFactors, customItems,
          taxMode, taxRate, customRate, discountType, discountValue,
          advance, payMethod, payNote, staffNote, buyerNote,
          orderRef: orderRefRef.current, step, savedAt: Date.now(),
        }));
      } else {
        localStorage.removeItem(CART_DRAFT_KEY);
      }
    } catch { /* storage blocked — non-fatal */ }
  }, [CART_DRAFT_KEY, buyer, buyerClientRef, cart, priceOverrides, splitFactors, customItems, taxMode, taxRate, customRate, discountType, discountValue, advance, payMethod, payNote, staffNote, buyerNote, step, confirmInfo]);

  // Warn before an accidental unload (refresh / edge-swipe back) with a live cart.
  useEffect(() => {
    const hasItems = Object.keys(cart).length > 0 && !confirmInfo;
    if (!hasItems) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [cart, confirmInfo]);

  // Custom items become pseudo-products so every cart feature (price edit,
  // split, steppers, totals) works on them unchanged. Not part of the catalog.
  const customProducts = useMemo(
    () =>
      Object.entries(customItems).map(
        ([sku, c]) =>
          ({
            sku,
            title: c.title,
            description: null,
            category: "Custom",
            sub_category: null,
            color: null,
            primary_fabric: null,
            wholesale_price: c.price,
            wholesale_visible: true,
            min_order_qty: null,
            restockable: true,
            restock_days: null,
            current_qty: 1,
            image_urls: c.image ? [c.image] : null,
            shopify_product_id: null,
            shopify_live_url: null,
            synced_at: null,
            images_fetched_at: null,
          }) as WholesaleProduct,
      ),
    [customItems],
  );
  const bySku = useMemo(
    () => new Map([...products, ...customProducts].map((p) => [p.sku, p])),
    [products, customProducts],
  );
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
  const catalogGroups = useMemo(() => groupByBase(catalogFiltered), [catalogFiltered]);
  // Effective unit price (billing override wins over the list price).
  const unitPriceOf = (p: WholesaleProduct) => {
    const raw = priceOverrides[p.sku];
    if (raw != null && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return p.wholesale_price;
  };

  // Billed figures under a GST split: N× the qty at 1/N the price. Line value
  // is unchanged (± a paisa of rounding); the SERVER recomputes from these
  // billed lines so the invoice always sums exactly.
  const splitOf = (sku: string) => Math.max(1, Math.floor(splitFactors[sku] ?? 1));
  const billedPriceOf = (p: WholesaleProduct) => {
    const f = splitOf(p.sku);
    const eff = unitPriceOf(p);
    return f === 1 ? eff : Math.round((eff / f) * 100) / 100;
  };
  // Smallest factor that brings the billed unit price to ≤ ₹2,500 (the slab).
  const suggestSplit = (price: number) => (price > 2500 ? Math.ceil(price / 2500) : 1);

  const cartLines = Object.entries(cart).map(([sku, qty]) => ({ p: bySku.get(sku)!, qty })).filter((l) => l.p);
  const cartCount = cartLines.length;
  const subtotal = cartLines.reduce((s, l) => s + l.qty * splitOf(l.p.sku) * billedPriceOf(l.p), 0);
  // Staff-assisted: MOQ/stock limits are advisory warnings, never blocks.
  const warningCount = cartLines.filter((l) => {
    const cap = qtyCap(l.p);
    return (l.p.min_order_qty != null && l.qty < l.p.min_order_qty) || (cap != null && l.qty > cap);
  }).length;

  // Discount (before tax), then tax — mirrors the server (which recomputes).
  const discountNum = Math.max(0, Number(discountValue) || 0);
  const discountAmount = discountType === "percent" ? Math.round(subtotal * (Math.min(100, discountNum) / 100) * 100) / 100
    : discountType === "absolute" ? Math.min(subtotal, discountNum)
    : 0;
  const netSubtotal = subtotal - discountAmount;
  const effRate = taxMode === "none" ? 0 : Math.min(18, Math.max(5, customRate.trim() !== "" ? Number(customRate) || 5 : taxRate));
  const taxAmount = taxMode === "exclusive" ? Math.round(netSubtotal * (effRate / 100) * 100) / 100
    : taxMode === "inclusive" ? Math.round(netSubtotal * (effRate / (100 + effRate)) * 100) / 100
    : 0;
  const grandTotal = taxMode === "exclusive" ? netSubtotal + taxAmount : netSubtotal;
  const advanceNum = Math.max(0, Number(advance) || 0);
  const balance = Math.max(0, grandTotal - advanceNum);

  const buyerMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buyers; // full list, scrollable — staff must see everyone
    return buyers.filter((b) => [b.business_name, b.owner_name, b.phone, b.city].some((v) => v?.toLowerCase().includes(q)));
  }, [buyers, query]);

  // No clamping here — the order taker can exceed stock caps and go below MOQ
  // (warnings shown in the cart, spec: staff limits are advisory).
  function setQty(sku: string, qty: number) {
    setCart((c) => {
      if (qty <= 0) { const next = { ...c }; delete next[sku]; return next; }
      return { ...c, [sku]: Math.floor(qty) };
    });
  }
  function changeCartQty(p: WholesaleProduct, qty: number) { setQty(p.sku, qty); }

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  async function addCustomItem() {
    const name = customForm.name.trim();
    if (!name) return;
    const price = Math.max(0, Number(customForm.price) || 0);
    // Photo is best-effort: offline or a failed upload never blocks the sale.
    let image: string | null = null;
    if (customForm.file) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        flash("Offline — adding without the photo");
      } else {
        setCustomUploading(true);
        try {
          const fd = new FormData();
          fd.append("image", customForm.file);
          const res = await uploadCustomItemPhoto(fd);
          if (res.ok) image = res.url ?? null;
          else flash(res.error ?? "Photo upload failed — added without it");
        } catch {
          flash("Photo upload failed — added without it");
        } finally {
          setCustomUploading(false);
        }
      }
    }
    const sku = `CUSTOM-${++customSeqRef.current}`;
    setCustomItems((m) => ({ ...m, [sku]: { title: name, price, image } }));
    setQty(sku, 1);
    setCustomForm({ open: false, name: "", price: "", file: null });
    flash(`${name} added to cart`);
  }

  const customItemForm = !customForm.open ? (
    <button
      type="button"
      onClick={() => setCustomForm({ open: true, name: "", price: "", file: null })}
      className="flex items-center gap-1.5 font-body mt-3"
      style={{ fontSize: 10.5, color: palette.goldDeep, letterSpacing: "0.06em" }}
    >
      <Plus size={12} /> Add a custom item (not on the portal)
    </button>
  ) : (
    <div className="mt-3 p-3" style={{ border: "1px dashed rgba(26,26,26,0.3)" }}>
      <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Custom item</div>
      <div className="flex gap-2 mt-2 flex-wrap items-center">
        <input
          value={customForm.name}
          onChange={(e) => setCustomForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Item name"
          autoFocus
          className="font-body bg-transparent outline-none flex-1"
          style={{ minWidth: 150, border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12 }}
        />
        <input
          value={customForm.price}
          onChange={(e) => setCustomForm((f) => ({ ...f, price: e.target.value }))}
          inputMode="decimal"
          placeholder="₹ / pc"
          className="font-body bg-transparent outline-none text-right"
          style={{ width: 84, border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12 }}
        />
        <button
          type="button"
          onClick={addCustomItem}
          disabled={!customForm.name.trim() || customUploading}
          className="font-body uppercase disabled:opacity-40"
          style={{ fontSize: 9, letterSpacing: "0.12em", padding: "8px 14px", background: palette.black, color: palette.ivory }}
        >
          {customUploading ? "Uploading…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => setCustomForm({ open: false, name: "", price: "", file: null })}
          aria-label="Close custom item form"
          className="p-1"
        >
          <X size={14} color={palette.mutedGreige} />
        </button>
      </div>
      {/* Photo — camera or gallery (no capture attr, so the phone offers both) */}
      <label className="flex items-center gap-2 mt-2 font-body" style={{ fontSize: 11, color: palette.softBlack }}>
        <span className="uppercase" style={{ fontSize: 8, letterSpacing: "0.16em", color: palette.mutedGreige }}>Photo</span>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setCustomForm((f) => ({ ...f, file: e.target.files?.[0] ?? null }))}
          className="font-body"
          style={{ fontSize: 11 }}
        />
      </label>
    </div>
  );

  // QR decode → add to cart (continuous: scanner stays open, returns feedback).
  function handleScan(text: string): { ok: boolean; message: string } {
    const sku = text.trim().toUpperCase();
    const product = products.find((p) => p.sku.toUpperCase() === sku);
    if (!product) return { ok: false, message: `SKU not found: ${text.trim()}` };
    const current = cartScanRef.current[product.sku] ?? 0;
    const next = current === 0 ? (product.min_order_qty ?? 1) : current + 1;
    setQty(product.sku, next);
    return { ok: true, message: `${product.title ?? product.sku} — ${next} in cart` };
  }

  function captureNew() {
    setError(null);
    start(async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const ref = uuid();
        await enqueue("capture", { clientRef: ref, form: nb });
        setBuyerClientRef(ref);
        setBuyer({ id: "", business_name: nb.business_name, owner_name: nb.owner_name, phone: nb.phone, city: nb.city });
        setNewBuyer(false);
        setCardFile(null); // don't carry this card onto the next buyer captured online
        try { localStorage.removeItem(NB_DRAFT_KEY); } catch { /* non-fatal */ }
        setNb(NB_EMPTY);
        setStep("catalog");
        return;
      }
      const res = await captureBuyer({ ...nb, clientRef: captureRefRef.current ?? (captureRefRef.current = uuid()) });
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      captureRefRef.current = null; // consumed — next capture gets a fresh key
      if (cardFile) {
        const fd = new FormData();
        fd.append("card", cardFile);
        await uploadBuyerCard(res.id!, fd); // best-effort
      }
      setBuyerClientRef(null);
      setBuyer({ id: res.id!, business_name: nb.business_name, owner_name: nb.owner_name, phone: nb.phone, city: nb.city });
      setNewBuyer(false);
      setCardFile(null);
      try { localStorage.removeItem(NB_DRAFT_KEY); } catch { /* non-fatal */ }
      setNb(NB_EMPTY);
      setStep("catalog");
    });
  }

  function submit() {
    if (!buyer) return;
    setError(null);
    const items = cartLines.map((l) => {
      const f = splitOf(l.p.sku);
      const billedPrice = billedPriceOf(l.p);
      const billedQty = l.qty * f;
      const cust = customItems[l.p.sku];
      return {
        sku: l.p.sku,
        qty: billedQty,
        // custom lines always carry an explicit price — the server has no
        // catalog row to fall back on
        ...(cust
          ? { unitPrice: billedPrice, customTitle: cust.title, ...(cust.image ? { customImageUrl: cust.image } : {}) }
          : billedPrice !== l.p.wholesale_price
            ? { unitPrice: billedPrice }
            : {}),
        ...(f > 1 ? { actualQty: l.qty } : {}),
      };
    });
    const taxPay = {
      taxMode, taxRate: effRate,
      discountType: discountType === "none" ? undefined : discountType,
      discountValue: discountType === "none" ? undefined : discountNum,
      advanceAmount: advanceNum, paymentMethod: advanceNum > 0 ? payMethod : undefined, paymentNotes: payNote || undefined,
    };
    // One key for this order across every retry / offline replay (idempotency).
    const clientRef = orderRefRef.current ?? (orderRefRef.current = uuid());
    start(async () => {
      // Queue when offline OR when the buyer was captured offline and has no
      // real id yet (buyerClientRef set). Submitting online with buyer.id="" was
      // a crash: Postgres rejects buyer_id="". The drainer resolves the ref to a
      // real id once the queued capture syncs.
      const buyerNotYetSynced = !buyer.id && !!buyerClientRef;
      if ((typeof navigator !== "undefined" && !navigator.onLine) || buyerNotYetSynced) {
        await enqueue("order", {
          sessionId: session.id, eventName: session.event_name, clientRef,
          buyerId: buyerClientRef ? undefined : buyer.id, buyerClientRef: buyerClientRef ?? undefined,
          items, staffNote, buyerNote, ...taxPay,
        });
        setConfirmInfo({ orderId: "", orderNumber: "Queued — will sync when back online" });
        setStep("confirm");
        return;
      }
      const res = await submitExhibitionOrder({
        sessionId: session.id, eventName: session.event_name, buyerId: buyer.id, items, staffNote, buyerNote, clientRef, ...taxPay,
      });
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setConfirmInfo({ orderId: res.orderId!, orderNumber: res.orderNumber ?? "", pdfUrl: res.pdfUrl });
      setStep("confirm");
    });
  }

  function saveBuyerContact() {
    if (!buyer) return;
    downloadVCard(
      buildVCard({
        ownerName: buyer.owner_name,
        businessName: buyer.business_name,
        phone: buyer.phone,
        email: null,
        city: buyer.city,
        status: "pending",
        onboarded: null,
      }),
      `${(buyer.owner_name ?? buyer.business_name ?? "buyer").replace(/\s+/g, "-")}.vcf`,
    );
    flash("Contact downloaded — import it on this device");
  }

  function invoiceShareText() {
    return `Drevi order ${confirmInfo?.orderNumber} — total ${formatINR(grandTotal)}. Invoice PDF: ${confirmInfo?.pdfUrl}`;
  }

  // Generic share sheet (AirDrop, mail, any app); falls back to copying.
  async function shareInvoice() {
    if (!confirmInfo?.pdfUrl) return;
    const text = invoiceShareText();
    if (navigator.share) {
      try { await navigator.share({ title: `Drevi ${confirmInfo.orderNumber}`, text }); return; } catch { /* cancelled */ }
    }
    await navigator.clipboard?.writeText(text);
    flash("Invoice link copied");
  }

  // Straight to WhatsApp.
  function shareInvoiceWhatsApp() {
    if (!confirmInfo?.pdfUrl) return;
    const phone = (buyer?.phone ?? "").replace(/\D/g, "");
    const base = phone ? `https://wa.me/${phone}` : "https://wa.me/";
    window.open(`${base}?text=${encodeURIComponent(invoiceShareText())}`, "_blank", "noopener");
  }

  function nextBuyer() {
    setBuyer(null); setBuyerClientRef(null); setCart({}); setStaffNote(""); setBuyerNote(""); setConfirmInfo(null); setQuery(""); setCatalogQuery("");
    setPriceOverrides({}); setSplitFactors({}); setDiscountType("none"); setDiscountValue(""); setAdvance(""); setPayNote("");
    // Also clear everything that would otherwise bleed into the next buyer:
    // the previous buyer's visiting-card photo (a cross-buyer data leak), their
    // GST mode/rate, payment method, and any custom items.
    setCardFile(null); setCustomItems({}); setCustomForm({ open: false, name: "", price: "", file: null });
    setTaxMode("none"); setTaxRate(5); setCustomRate(""); setPayMethod("Cash");
    orderRefRef.current = null; // fresh idempotency key for the next order
    setStep("buyer");
  }

  // ---------- Customer edit (cart page) ----------
  // A modal, not a step change, so closing lands staff exactly where they were.
  const [editBuyer, setEditBuyer] = useState<{ business_name: string; owner_name: string; phone: string; city: string } | null>(null);
  const [editBuyerErr, setEditBuyerErr] = useState<string | null>(null);

  function openBuyerEdit() {
    if (!buyer) return;
    setEditBuyerErr(null);
    setEditBuyer({
      business_name: buyer.business_name ?? "",
      owner_name: buyer.owner_name ?? "",
      phone: buyer.phone ?? "",
      city: buyer.city ?? "",
    });
  }

  function saveBuyerEdit() {
    const f = editBuyer;
    if (!f || !buyer) return;
    if (!f.business_name.trim() && !f.owner_name.trim() && !f.phone.trim()) {
      setEditBuyerErr("Keep at least one of business name, owner name, or phone.");
      return;
    }
    setEditBuyerErr(null);
    start(async () => {
      if (buyer.id) {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          setEditBuyerErr("You're offline — this customer is already saved, so edit once you're back online.");
          return;
        }
        const res = await updateBuyerContact(buyer.id, f);
        if (!res.ok) { setEditBuyerErr(res.error ?? "Could not save"); return; }
      } else if (buyerClientRef) {
        // Offline-captured buyer: patch the queued capture so the corrected
        // details are what eventually sync.
        await updateQueuedCaptureForm(buyerClientRef, f);
      }
      setBuyer((b) => (b ? { ...b, business_name: f.business_name.trim() || null, owner_name: f.owner_name.trim() || null, phone: f.phone.trim() || null, city: f.city.trim() || null } : b));
      setEditBuyer(null);
      flash("Customer details updated");
    });
  }

  // ---------- Hold / resume / discard (multiple buyers at the booth) ----------
  function holdCurrent() {
    const snap = snapshotCurrent();
    if (!snap || Object.keys(cart).length === 0) return;
    setParked((p) => [...p, snap]);
    flash(`${buyer?.business_name || buyer?.owner_name || "Order"} put on hold`);
    nextBuyer();
  }

  function discardCurrent() {
    if (!window.confirm(`Discard this order${buyer?.business_name ? ` for ${buyer.business_name}` : ""}? The cart will be cleared.`)) return;
    flash("Order discarded");
    nextBuyer();
  }

  function resumeParked(id: string) {
    const snap = parked.find((p) => p.id === id);
    if (!snap) return;
    const currentHasItems = !!buyer && Object.keys(cart).length > 0 && !confirmInfo;
    if (currentHasItems) {
      const who = buyer?.business_name || buyer?.owner_name || "the current order";
      if (!window.confirm(`Put ${who} on hold and resume ${snap.buyer.business_name || snap.buyer.owner_name || "this order"}?`)) return;
    }
    const currentSnap = currentHasItems ? snapshotCurrent() : null;
    setParked((p) => {
      const rest = p.filter((x) => x.id !== id);
      return currentSnap ? [...rest, currentSnap] : rest;
    });
    loadSnapshot(snap);
    setQuery(""); setCatalogQuery(""); setNewBuyer(false); setCardFile(null);
    setCustomForm({ open: false, name: "", price: "", file: null });
    setStep("cart");
    flash(`Resumed ${snap.buyer.business_name || snap.buyer.owner_name || "order"}`);
  }

  function discardParked(id: string) {
    const snap = parked.find((p) => p.id === id);
    if (!snap) return;
    if (!window.confirm(`Discard the held order for ${snap.buyer.business_name || snap.buyer.owner_name || "this buyer"}?`)) return;
    setParked((p) => p.filter((x) => x.id !== id));
  }

  function endSessionConfirmed() {
    const heldNote = parked.length > 0 ? ` ${parked.length} order(s) on hold will be discarded.` : "";
    if (!window.confirm(`Are you sure you want to exit and end this session?${heldNote}`)) return;
    try { localStorage.removeItem(PARKED_KEY); localStorage.removeItem(CART_DRAFT_KEY); } catch { /* non-fatal */ }
    endSession(session.id, session.event_name).then(() => router.push(session.type === "in_store" ? "/admin/in-store" : "/admin/exhibition"));
  }

  // ---------- Top bar ----------
  const topBar = (
    <div className="flex items-center justify-between flex-wrap gap-y-2 px-4 md:px-6 py-3" style={{ background: palette.black, color: palette.ivory }}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-display whitespace-nowrap" style={{ fontSize: 14, letterSpacing: "0.25em", fontWeight: 600 }}>DREVI · {session.type === "in_store" ? "IN-STORE" : "EXHIBITION"}</span>
        <span className="font-body truncate" style={{ fontSize: 10, letterSpacing: "0.1em", color: palette.champagne }}>{session.event_name}{buyer ? ` · ${buyer.business_name}` : ""}</span>
      </div>
      <div className="flex items-center gap-3 md:gap-4 flex-wrap">
        {parked.length > 0 && step !== "buyer" && (
          <button
            type="button"
            onClick={() => setStep("buyer")}
            className="font-body uppercase"
            style={{ border: "1px solid rgba(255,255,255,0.4)", color: palette.champagne, padding: "5px 12px", fontSize: 9, letterSpacing: "0.16em" }}
          >
            On Hold · {parked.length}
          </button>
        )}
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

      {session.ended && (
        <div className="px-4 md:px-6 py-2.5 font-body" style={{ background: palette.crimsonSoft, color: palette.crimsonText, fontSize: 12 }}>
          This session has ended — it’s read-only. Start a new session to take orders.
        </div>
      )}

      {error && <div className="px-4 md:px-6 py-2 font-body" style={{ background: palette.crimsonSoft, color: palette.crimsonText, fontSize: 12 }}>{error}</div>}

      {/* E3 — buyer */}
      {step === "buyer" && (
        <div className="px-4 md:px-6 py-5 max-w-xl">
          {parked.length > 0 && (
            <div className="mb-6">
              <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.2em", color: palette.goldDeep }}>
                On Hold ({parked.length})
              </div>
              <div className="mt-2 flex flex-col">
                {parked.map((p) => {
                  const lines = Object.keys(p.cart).length;
                  const pcs = Object.values(p.cart).reduce((n, q) => n + q, 0);
                  const mins = Math.max(1, Math.round((Date.now() - p.parkedAt) / 60000));
                  return (
                    <div key={p.id} className="flex items-center justify-between gap-3 py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
                      <div className="min-w-0">
                        <div className="font-display truncate" style={{ fontSize: 13.5, fontWeight: 600, color: palette.black }}>
                          {p.buyer.business_name || p.buyer.owner_name || "Unnamed buyer"}
                        </div>
                        <div className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
                          {lines} line{lines === 1 ? "" : "s"} · {pcs} pc{pcs === 1 ? "" : "s"} · held {mins} min ago
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => resumeParked(p.id)}
                          className="font-body uppercase"
                          style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.14em", padding: "7px 14px" }}
                        >
                          Resume
                        </button>
                        <button type="button" onClick={() => discardParked(p.id)} aria-label={`Discard held order for ${p.buyer.business_name ?? "buyer"}`} className="p-1.5">
                          <X size={14} color={palette.mutedGreige} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <h2 className="font-display" style={{ fontSize: 18, fontWeight: 600 }}>Who is this order for?</h2>
          {!newBuyer ? (
            <>
              <div className="flex items-center gap-2 mt-4" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "8px 10px" }}>
                <Search size={15} color={palette.mutedGreige} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search existing buyers" className="font-body bg-transparent outline-none w-full" style={{ fontSize: 13 }} />
              </div>
              <div className="mt-2 overflow-y-auto" style={{ maxHeight: "50vh" }}>
                {buyerMatches.length === 0 && (
                  <p className="font-body py-3" style={{ fontSize: 11, color: palette.mutedGreige }}>No matching buyers — capture them as new below.</p>
                )}
                {buyerMatches.map((b) => (
                  <button key={b.id} type="button" onClick={() => { setBuyer(b); setStep("catalog"); }} className="w-full text-left py-2.5" style={{ borderBottom: "1px solid rgba(26,26,26,0.08)" }}>
                    <div className="flex items-center gap-2">
                      <span className="font-display" style={{ fontSize: 13, fontWeight: 600 }}>{b.business_name ?? b.owner_name ?? "—"}</span>
                      {b.status === "pending" && (
                        <span className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.1em", color: palette.goldDeep, border: `1px solid ${palette.champagne}`, padding: "1px 5px" }}>Pending</span>
                      )}
                    </div>
                    {/* phone included so same-name businesses stay distinguishable */}
                    <div className="font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>{[b.owner_name, b.phone, b.city].filter(Boolean).join(" · ")}</div>
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
              ] as const).map((f) => (
                <label key={f.k} className="flex flex-col gap-1">
                  <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>{f.label}{("req" in f && f.req) ? " *" : ""}</span>
                  <input value={nb[f.k]} onChange={(e) => setNb({ ...nb, [f.k]: e.target.value })} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "6px 2px", fontSize: 13 }} />
                </label>
              ))}
              <PhoneInput value={nb.phone} onChange={(v) => setNb({ ...nb, phone: v })} required />
              {([
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
              <label className="flex flex-col gap-1">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.softBlack }}>visiting card / photo</span>
                {/* no `capture` attr — the phone offers camera AND gallery/files */}
                <input type="file" accept="image/*" onChange={(e) => setCardFile(e.target.files?.[0] ?? null)} className="font-body" style={{ fontSize: 12 }} />
                {cardFile && <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep }}>{cardFile.name} ({Math.round(cardFile.size / 1024)} KB)</span>}
              </label>
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
            <button type="button" onClick={() => setScanning(true)} aria-label="Scan QR" className="flex items-center gap-1.5 font-body uppercase flex-shrink-0" style={{ color: palette.goldDeep, fontSize: 9, letterSpacing: "0.14em" }}>
              <QrCode size={17} strokeWidth={1.8} /> Scan
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-4">
            {catalogGroups.map((g) => (
              <GroupedProductCard
                key={g.base}
                variants={g.variants}
                cartBySku={cart}
                onChangeQty={changeCartQty}
                enforceCaps={false}
                showPrices={showPrices}
                onGoToCart={() => setStep("cart")}
                onOpenDetail={setDetailProduct}
              />
            ))}
          </div>
          {catalogGroups.length === 0 && catalogQuery.trim() !== "" && (
            <p className="font-body mt-4" style={{ fontSize: 12, color: palette.mutedGreige }}>No designs match “{catalogQuery.trim()}”.</p>
          )}
          {/* Custom sale is reachable from the catalog too — it opens the cart
              with the custom-item form ready (pre-named from a dead-end search). */}
          <button
            type="button"
            onClick={() => {
              setCustomForm({ open: true, name: catalogGroups.length === 0 ? catalogQuery.trim() : "", price: "", file: null });
              setStep("cart");
            }}
            className="flex items-center gap-1.5 font-body mt-4"
            style={{ fontSize: 11, color: palette.goldDeep, letterSpacing: "0.06em" }}
          >
            <Plus size={13} />
            {catalogGroups.length === 0 && catalogQuery.trim() !== ""
              ? `Sell “${catalogQuery.trim()}” as a custom item`
              : "Custom sale — item not on the portal"}
          </button>
        </div>
      )}

      {/* E5 — cart */}
      {step === "cart" && (
        <div className="px-4 md:px-6 py-5 max-w-2xl">
          <button type="button" onClick={() => setStep("catalog")} className="flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}><ChevronLeft size={14} /> Catalog</button>
          <h2 className="font-display mt-2" style={{ fontSize: 18, fontWeight: 600 }}>Cart</h2>

          {/* Who this order is for — editable right here (modal), so staff land
              straight back on the cart. */}
          {buyer && (
            <div className="mt-3 p-3 flex items-start justify-between gap-3" style={{ background: palette.ivoryDeep }}>
              <div className="min-w-0">
                <div className="font-body uppercase" style={{ fontSize: 8, letterSpacing: "0.18em", color: palette.mutedGreige }}>Customer</div>
                <div className="font-display mt-0.5 truncate" style={{ fontSize: 14.5, fontWeight: 600, color: palette.black }}>
                  {buyer.business_name || buyer.owner_name || "Unnamed buyer"}
                </div>
                <div className="font-body mt-0.5" style={{ fontSize: 11, color: palette.softBlack }}>
                  {[buyer.business_name ? buyer.owner_name : null, buyer.phone, buyer.city].filter(Boolean).join(" · ") || "No contact details yet"}
                </div>
              </div>
              <button
                type="button"
                onClick={openBuyerEdit}
                className="font-body uppercase flex-shrink-0"
                style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 9, letterSpacing: "0.14em", padding: "7px 14px" }}
              >
                Edit
              </button>
            </div>
          )}
          {cartLines.length === 0 ? (
            <>
              <p className="font-body mt-4" style={{ fontSize: 12, color: palette.mutedGreige }}>No items yet.</p>
              {customItemForm}
            </>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {cartLines.map((l) => {
                const cap = qtyCap(l.p);
                const belowMoq = l.p.min_order_qty != null && l.qty < l.p.min_order_qty;
                const overCap = cap != null && l.qty > cap;
                const state = getStockState(l.p);
                const img = l.p.image_urls?.[0];
                const eff = unitPriceOf(l.p);
                const factor = splitOf(l.p.sku);
                const billedPrice = billedPriceOf(l.p);
                const suggested = suggestSplit(eff);
                return (
                  <div key={l.p.sku} className="flex items-center gap-3 p-3" style={{ border: "1px solid rgba(26,26,26,0.08)" }}>
                    <div className="relative flex-shrink-0" style={{ width: 88, height: 110, background: palette.ivoryDeep }}>
                      {img && <Image src={img} alt={l.p.title ?? l.p.sku} fill sizes="88px" className="object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-display" style={{ fontSize: 13, fontWeight: 500 }}>{l.p.title}</div>
                      <div className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.1em" }}>
                        {customItems[l.p.sku] ? "CUSTOM ITEM · NOT ON PORTAL" : l.p.sku}
                      </div>
                      {state === "made_to_order" && <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep }}>Made to Order · {l.p.restock_days}d</div>}
                      {belowMoq && <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep }}>Below minimum of {l.p.min_order_qty} — you can override</div>}
                      {overCap && <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep }}>Exceeds stock on hand ({cap} available, not restockable) — you can override</div>}
                      {factor > 1 ? (
                        <div className="font-body mt-1" style={{ fontSize: 10, color: palette.goldDeep, fontWeight: 600 }}>
                          Bill shows {l.qty * factor} × {formatINR(billedPrice)} · {l.qty} pc kept on record
                        </div>
                      ) : suggested > 1 ? (
                        <button
                          type="button"
                          onClick={() => setSplitFactors((s) => ({ ...s, [l.p.sku]: suggested }))}
                          className="font-body mt-1 text-left"
                          style={{ fontSize: 10, color: palette.goldDeep, borderBottom: `1px solid ${palette.gold}` }}
                        >
                          Over ₹2,500 — split ×{suggested} to bill @ {formatINR(eff / suggested)}
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <div className="flex items-center" style={{ border: "1px solid rgba(26,26,26,0.2)" }}>
                        <button type="button" onClick={() => setQty(l.p.sku, l.qty - 1)} className="px-2 py-1"><Minus size={12} /></button>
                        <span className="font-body" style={{ minWidth: 24, textAlign: "center", fontSize: 13 }}>{l.qty}</span>
                        <button type="button" onClick={() => setQty(l.p.sku, l.qty + 1)} className="px-2 py-1"><Plus size={12} /></button>
                      </div>
                      <label className="flex items-center gap-1 font-body" style={{ fontSize: 11, color: palette.mutedGreige }}>
                        ₹/pc
                        <input
                          inputMode="decimal"
                          value={priceOverrides[l.p.sku] ?? String(l.p.wholesale_price)}
                          onChange={(e) => setPriceOverrides((o) => ({ ...o, [l.p.sku]: e.target.value }))}
                          className="font-body bg-transparent outline-none text-right"
                          style={{ width: 70, border: "1px solid rgba(26,26,26,0.2)", padding: "4px 6px", fontSize: 12, color: unitPriceOf(l.p) !== l.p.wholesale_price ? palette.goldDeep : palette.black }}
                        />
                      </label>
                      {eff !== l.p.wholesale_price && (
                        <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, textDecoration: "line-through" }}>{formatINR(l.p.wholesale_price)}</span>
                      )}
                      <label className="flex items-center gap-1 font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>
                        Split
                        <select
                          value={factor}
                          onChange={(e) => setSplitFactors((s) => ({ ...s, [l.p.sku]: Number(e.target.value) }))}
                          className="font-body"
                          style={{ fontSize: 11, padding: "3px 4px", border: "1px solid rgba(26,26,26,0.2)", background: palette.ivory, color: factor > 1 ? palette.goldDeep : palette.black }}
                        >
                          <option value={1}>Off</option>
                          {[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>×{n}</option>)}
                        </select>
                      </label>
                      <span className="font-display" style={{ fontSize: 13, fontWeight: 600, minWidth: 64, textAlign: "right" }}>{formatINR(l.qty * factor * billedPrice)}</span>
                    </div>
                  </div>
                );
              })}

              {customItemForm}

              {/* Discount */}
              <div className="mt-3 p-3" style={{ background: palette.ivoryDeep }}>
                <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Discount</div>
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  {([["none", "None"], ["percent", "%"], ["absolute", "₹"]] as const).map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setDiscountType(v)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 12px", color: discountType === v ? palette.ivory : palette.softBlack, background: discountType === v ? palette.black : "transparent", border: discountType === v ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{label}</button>
                  ))}
                  {discountType !== "none" && (
                    <input
                      inputMode="decimal"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 500"}
                      className="font-body bg-transparent outline-none"
                      style={{ width: 90, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 12 }}
                    />
                  )}
                  {discountAmount > 0 && (
                    <span className="font-body" style={{ fontSize: 11, color: palette.goldDeep }}>− {formatINR(discountAmount)}</span>
                  )}
                </div>
              </div>

              {/* Tax */}
              <div className="mt-3 p-3" style={{ background: palette.ivoryDeep }}>
                <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Tax</div>
                <div className="flex gap-1.5 mt-2 flex-wrap items-center">
                  <button type="button" onClick={() => setTaxMode("none")} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 11px", color: taxMode === "none" ? palette.ivory : palette.softBlack, background: taxMode === "none" ? palette.black : "transparent", border: taxMode === "none" ? "none" : "1px solid rgba(26,26,26,0.2)" }}>No tax</button>
                  {GST_SLABS.map((r) => {
                    const active = taxMode !== "none" && customRate.trim() === "" && taxRate === r;
                    return (
                      <button key={r} type="button" onClick={() => { setTaxRate(r); setCustomRate(""); if (taxMode === "none") setTaxMode("exclusive"); }} className="font-body" style={{ fontSize: 10, padding: "6px 11px", color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{r}%</button>
                    );
                  })}
                  <input
                    inputMode="decimal"
                    value={customRate}
                    onChange={(e) => { setCustomRate(e.target.value); if (taxMode === "none" && e.target.value.trim() !== "") setTaxMode("exclusive"); }}
                    onBlur={() => { if (customRate.trim() !== "") { const n = Math.min(18, Math.max(5, Number(customRate) || 5)); setCustomRate(String(n)); } }}
                    placeholder="Custom %"
                    className="font-body bg-transparent outline-none"
                    style={{ width: 76, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 10 }}
                  />
                </div>
                {taxMode !== "none" && (
                  <div className="flex gap-1.5 mt-2">
                    {(["inclusive", "exclusive"] as const).map((m) => (
                      <button key={m} type="button" onClick={() => setTaxMode(m)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 11px", color: taxMode === m ? palette.ivory : palette.softBlack, background: taxMode === m ? palette.black : "transparent", border: taxMode === m ? "none" : "1px solid rgba(26,26,26,0.2)" }}>
                        {m === "inclusive" ? "Included in prices" : "Added on top"}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Totals */}
              <div className="mt-1 flex flex-col gap-1">
                <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.softBlack }}>
                  <span>Subtotal</span><span>{formatINR(subtotal)}</span>
                </div>
                {discountAmount > 0 && (
                  <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.goldDeep }}>
                    <span>Discount{discountType === "percent" ? ` (${Math.min(100, discountNum)}%)` : ""}</span><span>− {formatINR(discountAmount)}</span>
                  </div>
                )}
                {taxMode === "exclusive" && (
                  <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.softBlack }}>
                    <span>GST @ {effRate}%</span><span>{formatINR(taxAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between items-baseline" style={{ borderTop: "1px solid rgba(26,26,26,0.15)", paddingTop: 6 }}>
                  <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em" }}>Total</span>
                  <span className="font-display" style={{ fontSize: 19, fontWeight: 600 }}>{formatINR(grandTotal)}</span>
                </div>
                {taxMode === "inclusive" && (
                  <div className="font-body text-right" style={{ fontSize: 10, color: palette.mutedGreige }}>includes GST @ {effRate}% = {formatINR(taxAmount)}</div>
                )}
              </div>

              {/* Payment */}
              <div className="mt-1 p-3" style={{ background: palette.ivoryDeep }}>
                <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Payment</div>
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <label className="flex items-center gap-2 font-body" style={{ fontSize: 12 }}>
                    Advance ₹
                    <input inputMode="numeric" value={advance} onChange={(e) => setAdvance(e.target.value)} placeholder="0" className="font-body bg-transparent outline-none" style={{ width: 92, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 12 }} />
                  </label>
                  <div className="flex gap-1.5">
                    {PAY_METHODS.map((m) => (
                      <button key={m} type="button" onClick={() => setPayMethod(m)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "6px 10px", color: payMethod === m ? palette.ivory : palette.softBlack, background: payMethod === m ? palette.black : "transparent", border: payMethod === m ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{m}</button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-between font-body mt-2" style={{ fontSize: 12, color: advanceNum > 0 ? palette.goldDeep : palette.mutedGreige }}>
                  <span>Balance due</span><span style={{ fontWeight: 600 }}>{formatINR(balance)}</span>
                </div>
                <input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Payment note (optional)" className="w-full font-body bg-transparent outline-none mt-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 11 }} />
              </div>

              <label className="flex flex-col gap-1 mt-2"><span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Staff note</span><input value={staffNote} onChange={(e) => setStaffNote(e.target.value)} className="font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12 }} /></label>
              <label className="flex flex-col gap-1"><span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.16em", color: palette.mutedGreige }}>Buyer note</span><input value={buyerNote} onChange={(e) => setBuyerNote(e.target.value)} className="font-body bg-transparent outline-none" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "7px 9px", fontSize: 12 }} /></label>

              {warningCount > 0 && (
                <p className="font-body" style={{ fontSize: 11, color: palette.goldDeep }}>
                  {warningCount} line{warningCount > 1 ? "s" : ""} outside the usual limits — submitting anyway as a staff override.
                </p>
              )}
              {advanceNum > grandTotal && (
                <p className="font-body" style={{ fontSize: 11, color: palette.crimsonText }}>Advance can&apos;t exceed the total.</p>
              )}
              <button type="button" onClick={submit} disabled={isPending || advanceNum > grandTotal || session.ended} className="mt-2 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}>{isPending ? "Submitting…" : "Finalise Order"}</button>

              {/* Buyer stepped away or backed out? Hold keeps everything —
                  cart, prices, splits, tax, advance — resumable from the buyer
                  step; Discard clears it after a confirm. */}
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={holdCurrent}
                  disabled={isPending}
                  className="flex-1 font-body uppercase disabled:opacity-50"
                  style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em", padding: "10px 0" }}
                >
                  Hold — Next Buyer
                </button>
                <button
                  type="button"
                  onClick={discardCurrent}
                  disabled={isPending}
                  className="font-body uppercase px-5 disabled:opacity-50"
                  style={{ border: "1px solid rgba(155,44,44,0.5)", color: palette.crimsonText, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}
                >
                  Discard
                </button>
              </div>
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
            <div className="flex gap-2 justify-center mt-4 flex-wrap">
              <a href={`/api/orders/${confirmInfo.orderId}/pdf`} target="_blank" rel="noreferrer" className="inline-block font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "10px 18px", color: palette.black }}>Download PDF</a>
              {confirmInfo.pdfUrl && (
                <>
                  <button type="button" onClick={shareInvoice} className="flex items-center gap-1.5 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>
                    <Share2 size={13} strokeWidth={1.8} /> Share
                  </button>
                  <button type="button" onClick={shareInvoiceWhatsApp} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "10px 16px" }}>
                    <MessageCircle size={13} strokeWidth={1.8} /> WhatsApp
                  </button>
                </>
              )}
              {buyer && (
                <button type="button" onClick={saveBuyerContact} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "10px 18px" }}>Save Contact</button>
              )}
            </div>
          )}
          <div className="flex gap-2 justify-center mt-8">
            <button type="button" onClick={nextBuyer} className="font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 18px" }}>Next Buyer</button>
            <button type="button" onClick={endSessionConfirmed} className="font-body uppercase" style={{ border: `1px solid ${palette.black}`, fontSize: 10, letterSpacing: "0.18em", padding: "11px 18px" }}>End Session</button>
          </div>
        </div>
      )}

      {/* Customer edit modal — overlays the current step; closing returns to it */}
      {editBuyer && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.45)" }} onClick={() => !isPending && setEditBuyer(null)}>
          <div className="w-full sm:max-w-md" style={{ background: palette.ivory, padding: "20px 18px" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Edit Customer</h2>
              <button type="button" onClick={() => !isPending && setEditBuyer(null)} aria-label="Close"><X size={18} color={palette.softBlack} /></button>
            </div>
            <div className="flex flex-col gap-3 mt-4">
              <label className="flex flex-col gap-1">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Business name</span>
                <input value={editBuyer.business_name} onChange={(e) => setEditBuyer((f) => f && { ...f, business_name: e.target.value })} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 14 }} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Owner name</span>
                <input value={editBuyer.owner_name} onChange={(e) => setEditBuyer((f) => f && { ...f, owner_name: e.target.value })} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 14 }} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Phone</span>
                <PhoneInput value={editBuyer.phone} onChange={(v) => setEditBuyer((f) => f && { ...f, phone: v })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>City</span>
                <input value={editBuyer.city} onChange={(e) => setEditBuyer((f) => f && { ...f, city: e.target.value })} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 14 }} />
              </label>
            </div>
            {editBuyerErr && <p className="font-body mt-3" style={{ fontSize: 11.5, color: palette.crimsonText }}>{editBuyerErr}</p>}
            <div className="flex gap-2 mt-5">
              <button type="button" onClick={saveBuyerEdit} disabled={isPending} className="font-body uppercase flex-1 disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.16em", padding: "12px 0" }}>
                {isPending ? "Saving…" : "Save — Back to Cart"}
              </button>
              <button type="button" onClick={() => setEditBuyer(null)} disabled={isPending} className="font-body uppercase px-5 disabled:opacity-50" style={{ border: `1px solid ${palette.black}`, color: palette.black, background: "transparent", fontSize: 10, letterSpacing: "0.16em" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {scanning && (
        <QrScanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
          onGoToCart={() => { setScanning(false); setStep("cart"); }}
        />
      )}

      {detailProduct && (
        <ProductQuickView
          product={detailProduct}
          cartQty={cart[detailProduct.sku] ?? 0}
          onChangeQty={changeCartQty}
          onClose={() => setDetailProduct(null)}
          showPrices={showPrices}
          enforceCaps={false}
        />
      )}

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 20px", boxShadow: "0 8px 30px rgba(26,26,26,0.3)", zIndex: 60 }}>
          {toast}
        </div>
      )}

      <OfflineSync />
    </div>
  );
}
