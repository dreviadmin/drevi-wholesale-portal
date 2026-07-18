"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { X, Plus, Search, ScanLine } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { ZoomImage } from "@/components/Lightbox";
import { updateOrderItems, type OrderEditLine, type OrderEditTerms } from "@/app/admin/orders/actions";
import { formatINR, formatUnitINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { DiscountType, OrderItem, TaxMode } from "@/lib/types";

const PAY_METHODS = ["Cash", "UPI", "Bank", "Other"];
const TAX_RATES = [5, 12, 18];

export interface PickerProduct {
  sku: string;
  title: string | null;
  wholesale_price: number;
  image_url: string | null;
}

// Staff think in REAL pieces and REAL per-piece prices; the GST bill-split is
// a presentation factor on top ("bill as ×N cheaper units"). The editor works
// in those terms and derives the billed figures — so changing the real qty
// always moves the billed qty and the amount together.
interface DraftLine {
  key: string;
  kind: "keep" | "add" | "custom";
  index?: number; // position in the stored items array (keep lines)
  sku: string;
  title: string;
  image_url: string | null;
  qty: string; // real pieces
  price: string; // ₹ per real piece
  factor: string; // bill as ×N units ("1" = plain line)
  catalogPrice: number | null;
  // A stored ₹0 line (freebie custom item from the exhibition flow) stays
  // editable — the ₹0 block only applies to lines that had a price.
  wasZero?: boolean;
  // A stored actual_qty that doesn't map to a clean ×N factor (legacy data) is
  // carried through untouched instead of being re-derived and mangled.
  rawActual?: number | null;
}

// Stored figures are BILLED (qty inflated ×N, unit price deflated ÷N, real
// count in actual_qty). The billed unit is rounded to paise HERE so the
// preview, the "Bill shows" hint, and the server-stored total all agree.
function calc(l: Pick<DraftLine, "qty" | "price" | "factor">) {
  const qty = Math.max(1, Math.floor(Number(l.qty) || 1));
  const price = Math.max(0, Number(l.price) || 0);
  const f = Math.max(1, Math.floor(Number(l.factor) || 1));
  const billedUnit = f > 1 ? Math.round((price / f) * 100) / 100 : price;
  const billedQty = qty * f;
  const total = f > 1 ? Math.round(billedQty * billedUnit * 100) / 100 : qty * price;
  return { qty, price, f, billedQty, billedUnit, total };
}

export function OrderEditor({
  orderId,
  status,
  items,
  products,
  discountType,
  discountValue,
  taxMode,
  taxRate,
  advanceAmount,
  paymentMethod,
  paymentNotes,
}: {
  orderId: string;
  status: string;
  items: OrderItem[];
  products: PickerProduct[];
  discountType: DiscountType | null;
  discountValue: number | null;
  taxMode: TaxMode | null;
  taxRate: number | null;
  advanceAmount: number | null;
  paymentMethod: string | null;
  paymentNotes: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [isPending, start] = useTransition();
  // Billing terms — every option the cart page has, editable after the fact.
  const [dType, setDType] = useState<DiscountType | "none">("none");
  const [dValue, setDValue] = useState("");
  const [tMode, setTMode] = useState<TaxMode>("none");
  const [tRate, setTRate] = useState(5);
  const [customRate, setCustomRate] = useState("");
  const [advance, setAdvance] = useState("");
  const [payMethod, setPayMethod] = useState("Cash");
  const [payNote, setPayNote] = useState("");

  // The scanner's camera loop captures the first render's onScan, so state
  // must be read through this ref (its identity is stable across renders).
  // Monotonic id source for added/custom draft lines — a length-based key can
  // collide with a surviving line after a removal and edit both at once.
  const seqRef = useRef(0);
  const linesRef = useRef<DraftLine[]>(lines);
  linesRef.current = lines;

  const productBySku = useMemo(
    () => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])),
    [products],
  );

  function openEditor() {
    setLines(
      items.map((it, i) => {
        // Recover the real figures from a stored bill-split line — but only
        // when it's a well-formed ×N split. Anything else (legacy free-typed
        // data) keeps its billed figures verbatim and carries actual_qty
        // through untouched, so an open→save with no edits is a true no-op.
        const wellFormed =
          it.actual_qty != null && it.actual_qty >= 1 && it.actual_qty < it.qty && it.qty % it.actual_qty === 0;
        const factor = wellFormed ? it.qty / it.actual_qty! : 1;
        const realQty = wellFormed ? it.actual_qty! : it.qty;
        const realPrice = wellFormed ? Math.round(it.unit_price * factor * 100) / 100 : it.unit_price;
        return {
          key: `keep-${i}`,
          kind: "keep" as const,
          index: i,
          sku: it.sku,
          title: it.title,
          image_url: it.image_url ?? null,
          qty: String(realQty),
          price: String(realPrice),
          factor: String(factor),
          catalogPrice: null,
          wasZero: it.unit_price <= 0,
          rawActual: wellFormed ? null : it.actual_qty ?? null,
        };
      }),
    );
    // Billing terms start from the order's stored values.
    setDType(discountType ?? "none");
    setDValue(discountValue != null && discountValue > 0 ? String(discountValue) : "");
    setTMode(taxMode ?? "none");
    const storedRate = taxRate != null && taxRate > 0 ? taxRate : 5;
    setTRate(TAX_RATES.includes(storedRate) ? storedRate : 5);
    setCustomRate(TAX_RATES.includes(storedRate) ? "" : String(storedRate));
    setAdvance(advanceAmount != null && advanceAmount > 0 ? String(advanceAmount) : "");
    setPayMethod(paymentMethod ?? "Cash");
    setPayNote(paymentNotes ?? "");
    setQuery("");
    setError(null);
    setOpen(true);
  }

  function patch(key: string, field: "qty" | "price" | "factor" | "title", value: string) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }

  // A piece that isn't on the portal (yet): free-typed name + price.
  function addCustom(name: string) {
    setLines((ls) => [
      ...ls,
      {
        key: `custom-${++seqRef.current}`,
        kind: "custom",
        sku: "CUSTOM",
        title: name,
        image_url: null,
        qty: "1",
        price: "",
        factor: "1",
        catalogPrice: null,
      },
    ]);
    setQuery("");
  }

  function addProduct(p: PickerProduct) {
    setLines((ls) => [
      ...ls,
      {
        key: `add-${p.sku}-${++seqRef.current}`,
        kind: "add",
        sku: p.sku,
        title: p.title ?? p.sku,
        image_url: p.image_url,
        qty: "1",
        price: String(p.wholesale_price),
        factor: "1",
        catalogPrice: p.wholesale_price,
      },
    ]);
    setQuery("");
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.sku.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, products]);

  // QR scan → add the product, or bump the qty of a line that already has it.
  function handleAddScan(text: string): ScanFeedback {
    const key = text.trim().toUpperCase();
    const p = productBySku.get(key);
    if (!p) return { ok: false, message: `${text.trim()} — not in the catalog` };
    const existing = linesRef.current.find((l) => l.sku.trim().toUpperCase() === key);
    if (existing) {
      const newQty = Math.max(0, Math.floor(Number(existing.qty) || 0)) + 1;
      setLines((ls) =>
        ls.map((l) =>
          l.key === existing.key ? { ...l, qty: String(Math.max(0, Math.floor(Number(l.qty) || 0)) + 1) } : l,
        ),
      );
      return { ok: true, message: `${formatINR(p.wholesale_price)} — ${p.sku} · qty ${newQty}` };
    }
    addProduct(p);
    return { ok: true, message: `${formatINR(p.wholesale_price)} — ${p.sku} added` };
  }

  // Live preview from the editable billing terms — the server recomputes
  // authoritatively on save with the same math.
  const effRate = tMode === "none" ? 0 : Math.min(18, Math.max(5, customRate.trim() !== "" ? Number(customRate) || 5 : tRate));
  const advanceNum = Math.max(0, Number(advance) || 0);
  const preview = useMemo(() => {
    const subtotal = lines.reduce((s, l) => s + calc(l).total, 0);
    let discount = 0;
    if (dType !== "none") {
      const v = Math.max(0, Number(dValue) || 0);
      discount = dType === "percent" ? (subtotal * Math.min(100, v)) / 100 : Math.min(subtotal, v);
    }
    const net = subtotal - discount;
    const tax = tMode === "exclusive" ? (net * effRate) / 100 : tMode === "inclusive" ? (net * effRate) / (100 + effRate) : 0;
    const total = tMode === "exclusive" ? net + tax : net;
    return { subtotal, discount, tax, total };
  }, [lines, dType, dValue, tMode, effRate]);

  function save() {
    setError(null);
    if (lines.some((l) => l.kind === "custom" && !l.title.trim())) {
      setError("Give every custom item a name.");
      return;
    }
    // Block ₹0 only where it means "unpriced": catalog lines that had a price.
    // Custom lines carry an explicit price (a ₹0 freebie is legitimate), and a
    // stored ₹0 line stays editable rather than bricking the whole order.
    const unpriced = lines.find(
      (l) => calc(l).price <= 0 && l.kind !== "custom" && !(l.kind === "keep" && l.wasZero),
    );
    if (unpriced) {
      setError(`Set a price for ${unpriced.title || unpriced.sku} — a line can’t be ₹0.`);
      return;
    }
    const payload: OrderEditLine[] = lines.map((l) => {
      // Send the BILLED figures the invoice needs; the real count rides along
      // as actualQty whenever a split is in play.
      const { qty: realQty, f, billedQty, billedUnit } = calc(l);
      const qty = billedQty;
      const unitPrice = billedUnit;
      const actualQty = f > 1 ? realQty : l.rawActual ?? null;
      if (l.kind === "keep") return { kind: "keep", index: l.index!, qty, unitPrice, actualQty };
      if (l.kind === "custom") return { kind: "custom", title: l.title.trim(), qty, unitPrice, actualQty };
      return { kind: "add", sku: l.sku, qty, unitPrice, actualQty };
    });
    const terms: OrderEditTerms = {
      taxMode: tMode,
      taxRate: tMode === "none" ? null : effRate,
      discountType: dType === "none" ? null : dType,
      discountValue: dType === "none" ? null : Math.max(0, Number(dValue) || 0),
      advanceAmount: advanceNum,
      paymentMethod: advanceNum > 0 ? payMethod : null,
      paymentNotes: payNote || null,
    };
    start(async () => {
      const res = await updateOrderItems(orderId, payload, terms);
      if (!res.ok) { setError(res.error ?? "Failed to save"); return; }
      if (res.overpaidBy && res.overpaidBy > 0) {
        // Non-blocking: the edit saved, but staff need to know a refund is owed.
        alert(`Saved. Note: the buyer has now overpaid by ${formatINR(res.overpaidBy)} (advance exceeds the new total) — record a refund.`);
      }
      setOpen(false);
      router.refresh();
    });
  }

  const label = (t: string) => (
    <span className="font-body uppercase block" style={{ fontSize: 8, letterSpacing: "0.14em", color: palette.mutedGreige }}>{t}</span>
  );
  const numInput = (value: string, onChange: (v: string) => void, width = 64, placeholder = "") => (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="font-body bg-transparent outline-none text-right"
      style={{ fontSize: 13, width, color: palette.black, borderBottom: `1px solid rgba(26,26,26,0.25)`, padding: "2px 4px" }}
    />
  );

  if (status !== "submitted" && status !== "confirmed") return null;

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        className="font-body uppercase"
        style={{ fontSize: 9, letterSpacing: "0.15em", padding: "7px 12px", background: "transparent", color: palette.black, border: `1px solid ${palette.black}` }}
      >
        Modify Order
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(26,26,26,0.45)" }} onClick={() => !isPending && setOpen(false)}>
          <div
            className="w-full sm:max-w-xl max-h-modal overflow-y-auto"
            style={{ background: palette.ivory, padding: "20px 18px", paddingBottom: "calc(20px + var(--kb-inset, 0px))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display" style={{ fontSize: 17, fontWeight: 600, color: palette.black }}>Modify Order</h2>
              <button type="button" onClick={() => !isPending && setOpen(false)} aria-label="Close"><X size={18} color={palette.softBlack} /></button>
            </div>

            <div className="mt-3" style={{ borderTop: "1px solid rgba(26,26,26,0.1)" }}>
              {lines.map((l) => (
                <div key={l.key} className="py-3" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                  <div className="flex items-start gap-3">
                    {l.image_url ? (
                      <ZoomImage src={l.image_url} alt={l.title} width={40} height={50} />
                    ) : (
                      <div className="relative flex-shrink-0" style={{ width: 40, height: 50, background: palette.ivoryDeep }} />
                    )}
                    <div className="min-w-0 flex-1">
                      {l.kind === "custom" ? (
                        <input
                          value={l.title}
                          onChange={(e) => patch(l.key, "title", e.target.value)}
                          placeholder="Item name"
                          autoFocus={!l.title}
                          className="font-display w-full bg-transparent outline-none"
                          style={{ fontSize: 13, color: palette.black, fontWeight: 500, borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "1px 2px" }}
                        />
                      ) : (
                        <div className="font-display truncate" style={{ fontSize: 13, color: palette.black, fontWeight: 500 }}>{l.title}</div>
                      )}
                      <div className="font-body" style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.1em" }}>
                        {l.kind === "custom" ? "CUSTOM ITEM · NOT ON PORTAL" : `${l.sku}${l.kind === "add" ? " · NEW" : ""}`}
                      </div>
                    </div>
                    <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.sku}`} className="p-1">
                      <X size={14} color={palette.mutedGreige} />
                    </button>
                  </div>
                  <div className="flex items-end gap-4 mt-2 flex-wrap" style={{ paddingLeft: 52 }}>
                    <div>{label("Qty (pcs)")}{numInput(l.qty, (v) => patch(l.key, "qty", v), 56)}</div>
                    <div>{label("Price / pc ₹")}{numInput(l.price, (v) => patch(l.key, "price", v), 84)}</div>
                    <div>{label("Bill as ×N")}{numInput(l.factor, (v) => patch(l.key, "factor", v), 44)}</div>
                    <div className="ml-auto text-right">
                      {label("Line total")}
                      <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>
                        {formatINR(calc(l).total)}
                      </span>
                    </div>
                  </div>
                  {calc(l).f > 1 && (
                    <div className="font-body mt-1.5" style={{ paddingLeft: 52, fontSize: 10, color: palette.goldDeep, fontWeight: 600 }}>
                      Bill shows {calc(l).billedQty} × {formatUnitINR(calc(l).billedUnit)} · {calc(l).qty} pc kept on record
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4">
              <div className="flex items-center gap-2" style={{ borderBottom: `1px solid rgba(26,26,26,0.25)`, padding: "4px 2px" }}>
                <Search size={14} color={palette.mutedGreige} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Add item — search name or SKU"
                  className="font-body flex-1 bg-transparent outline-none"
                  style={{ fontSize: 12.5, color: palette.black }}
                />
                <button
                  type="button"
                  onClick={() => setScanning(true)}
                  aria-label="Scan QR to add"
                  className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
                  style={{ fontSize: 9, letterSpacing: "0.12em", padding: "5px 9px", background: palette.black, color: palette.ivory }}
                >
                  <ScanLine size={13} strokeWidth={1.7} /> Scan
                </button>
              </div>
              {matches.length > 0 && (
                <div style={{ border: "1px solid rgba(26,26,26,0.1)", borderTop: "none" }}>
                  {matches.map((p) => (
                    <button
                      key={p.sku}
                      type="button"
                      onClick={() => addProduct(p)}
                      className="w-full flex items-center gap-3 px-2 py-2 text-left"
                      style={{ borderBottom: "1px solid rgba(26,26,26,0.05)", background: palette.ivory }}
                    >
                      <div className="relative flex-shrink-0" style={{ width: 28, height: 35, background: palette.ivoryDeep }}>
                        {p.image_url && <Image src={p.image_url} alt="" fill sizes="28px" className="object-cover" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-body truncate" style={{ fontSize: 12, color: palette.black }}>{p.title ?? p.sku}</div>
                        <div className="font-body" style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.08em" }}>{p.sku} · {formatINR(p.wholesale_price)}</div>
                      </div>
                      <Plus size={14} color={palette.goldDeep} />
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => addCustom(matches.length === 0 ? query.trim() : "")}
                className="flex items-center gap-1.5 font-body mt-2"
                style={{ fontSize: 10.5, color: palette.goldDeep, letterSpacing: "0.06em" }}
              >
                <Plus size={12} />
                {query.trim() && matches.length === 0
                  ? `Add “${query.trim()}” as a custom item`
                  : "Add a custom item (not on the portal)"}
              </button>
            </div>

            {/* Billing — every option the cart page has, editable after the fact */}
            <div className="mt-5 p-3" style={{ background: palette.ivoryDeep }}>
              <div className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Discount</div>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {([["none", "None"], ["percent", "%"], ["absolute", "₹ Off"]] as const).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setDType(v)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 12px", color: dType === v ? palette.ivory : palette.softBlack, background: dType === v ? palette.black : "transparent", border: dType === v ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{label}</button>
                ))}
                {dType !== "none" && (
                  <input
                    inputMode="decimal"
                    value={dValue}
                    onChange={(e) => setDValue(e.target.value)}
                    placeholder={dType === "percent" ? "e.g. 10" : "e.g. 500"}
                    className="font-body bg-transparent outline-none"
                    style={{ width: 84, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 12 }}
                  />
                )}
              </div>

              <div className="font-body uppercase mt-3" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>GST</div>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <button type="button" onClick={() => setTMode("none")} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 11px", color: tMode === "none" ? palette.ivory : palette.softBlack, background: tMode === "none" ? palette.black : "transparent", border: tMode === "none" ? "none" : "1px solid rgba(26,26,26,0.2)" }}>No tax</button>
                {TAX_RATES.map((r) => {
                  const active = tMode !== "none" && customRate.trim() === "" && tRate === r;
                  return (
                    <button key={r} type="button" onClick={() => { setTRate(r); setCustomRate(""); if (tMode === "none") setTMode("exclusive"); }} className="font-body" style={{ fontSize: 10, padding: "6px 11px", color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{r}%</button>
                  );
                })}
                <input
                  inputMode="decimal"
                  value={customRate}
                  onChange={(e) => { setCustomRate(e.target.value); if (tMode === "none" && e.target.value.trim() !== "") setTMode("exclusive"); }}
                  onBlur={() => { if (customRate.trim() !== "") setCustomRate(String(Math.min(18, Math.max(5, Number(customRate) || 5)))); }}
                  placeholder="Custom %"
                  className="font-body bg-transparent outline-none"
                  style={{ width: 76, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 10 }}
                />
              </div>
              {tMode !== "none" && (
                <div className="flex gap-1.5 mt-2">
                  {(["inclusive", "exclusive"] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setTMode(m)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 11px", color: tMode === m ? palette.ivory : palette.softBlack, background: tMode === m ? palette.black : "transparent", border: tMode === m ? "none" : "1px solid rgba(26,26,26,0.2)" }}>
                      {m === "inclusive" ? "Included in prices" : "Added on top"}
                    </button>
                  ))}
                </div>
              )}

              <div className="font-body uppercase mt-3" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Payment</div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <label className="flex items-center gap-2 font-body" style={{ fontSize: 12 }}>
                  Advance ₹
                  <input inputMode="numeric" value={advance} onChange={(e) => setAdvance(e.target.value)} placeholder="0" className="font-body bg-transparent outline-none" style={{ width: 92, border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 12, background: palette.ivory }} />
                </label>
                <div className="flex gap-1.5">
                  {PAY_METHODS.map((m) => (
                    <button key={m} type="button" onClick={() => setPayMethod(m)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", padding: "6px 10px", color: payMethod === m ? palette.ivory : palette.softBlack, background: payMethod === m ? palette.black : "transparent", border: payMethod === m ? "none" : "1px solid rgba(26,26,26,0.2)" }}>{m}</button>
                  ))}
                </div>
              </div>
              <input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Payment note (optional)" className="w-full font-body bg-transparent outline-none mt-2" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "6px 8px", fontSize: 11, background: palette.ivory }} />
            </div>

            <div className="mt-4 font-body" style={{ fontSize: 12, color: palette.softBlack }}>
              <div className="flex justify-between"><span>Subtotal</span><span>{formatINR(preview.subtotal)}</span></div>
              {preview.discount > 0 && (
                <div className="flex justify-between mt-1" style={{ color: palette.goldDeep }}>
                  <span>Discount{dType === "percent" ? ` (${Math.min(100, Number(dValue) || 0)}%)` : ""}</span><span>− {formatINR(preview.discount)}</span>
                </div>
              )}
              {tMode === "exclusive" && <div className="flex justify-between mt-1"><span>GST @ {effRate}% (added)</span><span>{formatINR(preview.tax)}</span></div>}
              <div className="flex justify-between items-baseline mt-2">
                <span className="uppercase" style={{ fontSize: 10, letterSpacing: "0.18em" }}>New total</span>
                <span className="font-display" style={{ fontSize: 19, fontWeight: 600, color: palette.black }}>{formatINR(preview.total)}</span>
              </div>
              {tMode === "inclusive" && <div className="text-right mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>includes GST @ {effRate}% = {formatINR(preview.tax)}</div>}
              <div className="flex justify-between mt-1" style={{ color: advanceNum > 0 ? palette.goldDeep : palette.mutedGreige }}>
                <span>Balance due</span><span style={{ fontWeight: 600 }}>{formatINR(Math.max(0, preview.total - advanceNum))}</span>
              </div>
              {advanceNum > preview.total && (
                <p className="mt-1" style={{ fontSize: 10.5, color: palette.crimsonText }}>
                  Advance exceeds the new total by {formatINR(advanceNum - preview.total)} — a refund will be owed.
                </p>
              )}
            </div>

            {error && <p className="font-body mt-3" style={{ fontSize: 11.5, color: "#9b2c2c" }}>{error}</p>}

            <div className="flex gap-2 mt-5">
              <button
                type="button"
                onClick={save}
                disabled={isPending || lines.length === 0}
                className="font-body uppercase flex-1 disabled:opacity-50"
                style={{ fontSize: 10, letterSpacing: "0.16em", padding: "11px 0", background: palette.black, color: palette.ivory }}
              >
                {isPending ? "Saving…" : "Save Changes"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={isPending}
                className="font-body uppercase px-5"
                style={{ fontSize: 10, letterSpacing: "0.16em", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent" }}
              >
                Cancel
              </button>
            </div>
            <p className="font-body mt-2" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
              Qty and price are the real figures. “Bill as ×N” shows one piece as N cheaper units on the invoice (GST split) — the real count stays on record. Saving regenerates the invoice PDF.
            </p>
          </div>
        </div>
      )}

      {scanning && <QrScanner title="Scan to add items" onScan={handleAddScan} onClose={() => setScanning(false)} />}
    </>
  );
}
