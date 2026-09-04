"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ScanLine, Search, Trash2, X } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { createRetailBill, updateRetailBill } from "./actions";
import type { DiscountType, RetailBill, TaxMode } from "@/lib/types";

// Retail billing form (31 Aug). Scan or search → line with the retail price
// prefilled (editable when negotiated) → optional customer, discount, GST,
// payment → bill date (past allowed) → save. The server recomputes money and
// treats the retail price as the floor of trust.

export interface CatalogRow {
  sku: string;
  title: string;
  category: string | null;
  color: string | null;
  stock: number;
  image: string | null;
  retailPrice: number;
}

// price as text for free editing; custom lines carry a title (+ optional
// catalog-sync flag, unchecked by default — Ansh, 4 Sep).
interface Line { sku: string; qty: number; price: string; custom?: boolean; title?: string; syncToCatalog?: boolean }

const chip = (active: boolean) => ({
  fontSize: 9.5, letterSpacing: "0.12em", padding: "6px 11px",
  background: active ? palette.black : "transparent",
  color: active ? palette.ivory : palette.softBlack,
  border: active ? "none" : "1px solid rgba(26,26,26,0.2)",
});

export function RetailBillForm({ catalog, editBill }: { catalog: CatalogRow[]; editBill?: RetailBill | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    editBill
      ? (editBill.items ?? []).map((it) => ({
          sku: it.sku, qty: it.qty, price: String(it.unit_price),
          ...(it.custom ? { custom: true, title: it.title } : {}),
        }))
      : [],
  );
  const [customerName, setCustomerName] = useState(editBill?.customer_name ?? "");
  const [customerPhone, setCustomerPhone] = useState(editBill?.customer_phone ?? "");
  const [discountType, setDiscountType] = useState<DiscountType | "none">(editBill?.discount_type ?? "none");
  const [discountValue, setDiscountValue] = useState(editBill?.discount_value ? String(editBill.discount_value) : "");
  const [taxMode, setTaxMode] = useState<TaxMode>(editBill?.tax_mode ?? "none");
  const [taxRate, setTaxRate] = useState(editBill?.tax_rate ? Number(editBill.tax_rate) : 5);
  const [payMethod, setPayMethod] = useState(editBill?.payment_method ?? "Cash");
  // Custom-item mini form
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ title: "", price: "", sku: "", sync: false });
  const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [billDate, setBillDate] = useState("");
  const [savedInfo, setSavedInfo] = useState<{ billNumber: string; pdfUrl?: string; warning?: string } | null>(null);
  // One idempotency key per bill attempt — a double-tap or retried request
  // resolves to the same bill server-side. Re-minted after each save.
  const [clientRef, setClientRef] = useState<string>(() => crypto.randomUUID());
  const lowArmedRef = useRef(false);

  const bySku = useMemo(() => new Map(catalog.map((c) => [c.sku.toUpperCase(), c])), [catalog]);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 3000); }

  function addSku(raw: string): boolean {
    const sku = raw.trim().toUpperCase();
    const c = bySku.get(sku);
    if (!c) return false;
    setLines((prev) => {
      const at = prev.findIndex((l) => l.sku === sku);
      if (at >= 0) return prev.map((l, i) => (i === at ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { sku, qty: 1, price: c.retailPrice > 0 ? String(c.retailPrice) : "" }];
    });
    return true;
  }

  function handleScan(text: string): ScanFeedback {
    const ok = addSku(text);
    return ok ? { ok: true, message: text.trim().toUpperCase() } : { ok: false, message: `${text.trim().toUpperCase()} — not in the catalog` };
  }

  const matches = query.trim()
    ? catalog.filter((c) => `${c.sku} ${c.title}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6)
    : [];

  const subtotal = lines.reduce((s, l) => s + l.qty * (Number(l.price) || 0), 0);
  const discountNum = Number(discountValue) || 0;
  const discountAmt = discountType === "percent" ? (subtotal * Math.min(100, discountNum)) / 100 : discountType === "absolute" ? Math.min(subtotal, discountNum) : 0;
  const net = subtotal - discountAmt;
  const taxAmt = taxMode === "exclusive" ? (net * taxRate) / 100 : taxMode === "inclusive" ? (net * taxRate) / (100 + taxRate) : 0;
  const grandTotal = taxMode === "exclusive" ? net + taxAmt : net;
  // ₹0 is only invalid where it means "unpriced" — a custom freebie is fine.
  const unpriced = lines.filter((l) => !l.custom && (Number(l.price) || 0) <= 0);

  function addCustom() {
    const title = custom.title.trim();
    if (!title) { flash("A custom item needs a name."); return; }
    if (custom.sync && !custom.sku.trim()) { flash("Catalog sync needs a SKU — give the item one, or untick the sync."); return; }
    setLines((prev) => [...prev, {
      sku: custom.sku.trim().toUpperCase() || "CUSTOM",
      qty: 1,
      price: custom.price || "0",
      custom: true,
      title,
      syncToCatalog: custom.sync,
    }]);
    setCustom({ title: "", price: "", sku: "", sync: false });
    setCustomOpen(false);
  }

  function save() {
    if (lines.length === 0) { flash("Add at least one item."); return; }
    if (unpriced.length > 0) { flash(`Set a price for ${unpriced[0].sku}.`); return; }
    // Typo guard (review fix, 31 Aug): a price far below MRP is usually a slip
    // (₹5 for a ₹5,999 gown), sometimes a real bargain — warn once, second tap
    // proceeds. Negotiation stays possible; accidents don't sail through.
    const low = lines.filter((l) => {
      const mrp = bySku.get(l.sku)?.retailPrice ?? 0;
      return mrp > 0 && (Number(l.price) || 0) < mrp * 0.4;
    });
    if (low.length > 0 && !lowArmedRef.current) {
      lowArmedRef.current = true;
      setTimeout(() => { lowArmedRef.current = false; }, 6000);
      flash(`${low[0].sku} is priced far below its MRP — tap Save again if that's intended.`);
      return;
    }
    lowArmedRef.current = false;
    const payload = {
      items: lines.map((l) => ({
        sku: l.sku, qty: l.qty, unitPrice: Number(l.price),
        ...(l.custom ? { customTitle: l.title, syncToCatalog: l.syncToCatalog } : {}),
      })),
      customerName: customerName || undefined,
      customerPhone: customerPhone || undefined,
      discountType: discountType === "none" ? undefined : discountType,
      discountValue: discountType === "none" ? undefined : discountNum,
      taxMode, taxRate,
      paymentMethod: payMethod,
    };
    start(async () => {
      if (editBill) {
        const r = await updateRetailBill(editBill.id, payload);
        if (!r.ok) { flash(r.error ?? "Failed"); return; }
        setSavedInfo({ billNumber: `${editBill.bill_number} updated`, warning: r.warning });
        router.push("/admin/retail-bill");
        router.refresh();
        return;
      }
      const r = await createRetailBill({ ...payload, billDate: billDate || undefined, clientRef });
      if (!r.ok) { flash(r.error ?? "Failed"); return; }
      setSavedInfo({ billNumber: r.billNumber!, pdfUrl: r.pdfUrl, warning: r.warning });
      setLines([]); setCustomerName(""); setCustomerPhone(""); setDiscountType("none"); setDiscountValue("");
      setTaxMode("none"); setBillDate("");
      setClientRef(crypto.randomUUID());
      router.refresh();
    });
  }

  return (
    <div className="mt-5">
      {editBill && (
        <div className="p-3 mb-4 flex items-center justify-between gap-2 flex-wrap" style={{ background: "rgba(196,163,90,0.12)", border: "1px solid rgba(196,163,90,0.5)" }}>
          <span className="font-body" style={{ fontSize: 12.5, color: palette.goldDeep, fontWeight: 600 }}>
            Editing {editBill.bill_number} — stock adjusts to the changes; the PDF regenerates.
          </span>
          <button type="button" onClick={() => router.push("/admin/retail-bill")} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.mutedGreige, textDecoration: "underline" }}>
            Cancel edit
          </button>
        </div>
      )}
      {savedInfo && (
        <div className="p-3 mb-4 flex items-center justify-between gap-2 flex-wrap" style={{ background: savedInfo.warning ? "#F3E9CE" : "rgba(31,107,69,0.1)", border: `1px solid ${savedInfo.warning ? "rgba(196,163,90,0.5)" : "rgba(31,107,69,0.35)"}` }}>
          <span className="font-body" style={{ fontSize: 12.5, color: savedInfo.warning ? "#8a6d1a" : "#1F6B45", fontWeight: 600 }}>
            {savedInfo.billNumber} saved.{savedInfo.warning ? ` ${savedInfo.warning}` : ""}
          </span>
          <span className="flex items-center gap-3">
            {savedInfo.pdfUrl && (
              <a href={savedInfo.pdfUrl} target="_blank" rel="noreferrer" className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>Open PDF</a>
            )}
            <button type="button" onClick={() => setSavedInfo(null)} aria-label="Dismiss"><X size={14} color={palette.mutedGreige} /></button>
          </span>
        </div>
      )}

      {/* Add items */}
      <div className="flex gap-2">
        <button type="button" onClick={() => setScanning(true)} className="flex items-center gap-2 font-body uppercase" style={{ fontSize: 10.5, letterSpacing: "0.16em", background: palette.gold, color: palette.black, padding: "11px 16px", fontWeight: 600 }}>
          <ScanLine size={15} strokeWidth={2} /> Scan
        </button>
        <div className="flex items-center gap-2 flex-1" style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "0 10px", background: "#fff" }}>
          <Search size={14} color={palette.mutedGreige} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title or SKU" className="font-body flex-1 bg-transparent outline-none" style={{ fontSize: 12.5, color: palette.black }} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear"><X size={13} color={palette.mutedGreige} /></button>}
        </div>
      </div>
      {matches.length > 0 && (
        <div style={{ border: "1px solid rgba(26,26,26,0.12)", borderTop: "none", background: "#fff" }}>
          {matches.map((c) => (
            <button key={c.sku} type="button" onClick={() => { addSku(c.sku); setQuery(""); }} className="w-full flex items-center gap-2.5 px-3 py-2 text-left" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
              <div className="relative flex-shrink-0" style={{ width: 30, height: 38, background: palette.ivoryDeep }}>
                {c.image && <Image src={c.image} alt="" fill sizes="30px" className="object-cover" />}
              </div>
              <span className="min-w-0 flex-1">
                <span className="font-body block truncate" style={{ fontSize: 12, color: palette.black }}>{c.title}</span>
                <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>{c.sku} · stock {c.stock}</span>
              </span>
              <span className="font-body" style={{ fontSize: 12, fontWeight: 600, color: palette.black }}>{c.retailPrice > 0 ? formatINR(c.retailPrice) : "no MRP"}</span>
            </button>
          ))}
        </div>
      )}

      {/* Custom item (parity with the wholesale cart — Ansh, 4 Sep) */}
      <div className="mt-2">
        {!customOpen ? (
          <button type="button" onClick={() => setCustomOpen(true)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.12em", color: palette.goldDeep, textDecoration: "underline" }}>
            + Add a custom item (not on the portal)
          </button>
        ) : (
          <div className="p-3 flex flex-col gap-2" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.12)" }}>
            <input value={custom.title} onChange={(e) => setCustom((c) => ({ ...c, title: e.target.value }))} placeholder="Item name, e.g. Matching potli bag" className="font-body p-2" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
            <div className="flex gap-2 flex-wrap">
              <input value={custom.price} inputMode="decimal" onChange={(e) => setCustom((c) => ({ ...c, price: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="₹ price (0 = freebie)" className="font-body p-2" style={{ fontSize: 12, width: 140, border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
              <input value={custom.sku} onChange={(e) => setCustom((c) => ({ ...c, sku: e.target.value.toUpperCase() }))} placeholder="SKU (optional)" className="font-mono p-2" style={{ fontSize: 11.5, width: 180, border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
            </div>
            <label className="flex items-center gap-2 font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>
              <input type="checkbox" checked={custom.sync} onChange={(e) => setCustom((c) => ({ ...c, sync: e.target.checked }))} style={{ accentColor: palette.goldDeep, width: 15, height: 15 }} />
              Also add to the catalog (needs a SKU — lands hidden, complete it in Manage Catalog)
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={addCustom} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 12px" }}>
                Add to bill
              </button>
              <button type="button" onClick={() => setCustomOpen(false)} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.1em", color: palette.mutedGreige, padding: "8px 4px" }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lines */}
      {lines.length > 0 && (
        <div className="mt-4" style={{ borderTop: "1px solid rgba(26,26,26,0.12)" }}>
          {lines.map((l, i) => {
            const c = l.custom ? undefined : bySku.get(l.sku);
            return (
              <div key={`${l.sku}-${i}`} className="flex items-center gap-2.5 py-2.5 flex-wrap" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <div className="min-w-0 flex-1" style={{ minWidth: 160 }}>
                  <div className="font-body truncate" style={{ fontSize: 12.5, color: palette.black }}>{l.custom ? l.title : c?.title ?? l.sku}</div>
                  <div className="font-body" style={{ fontSize: 9, color: palette.mutedGreige, letterSpacing: "0.06em" }}>
                    {l.custom
                      ? `custom · ${l.sku}${l.syncToCatalog ? " · will join the catalog" : " · not on the portal"}`
                      : `${l.sku}${c && c.retailPrice > 0 ? ` · MRP ${formatINR(c.retailPrice)}` : " · no MRP set"}`}
                  </div>
                </div>
                <div className="flex items-center" style={{ border: "1px solid rgba(26,26,26,0.2)" }}>
                  <button type="button" aria-label={`Fewer ${l.sku}`} onClick={() => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} className="font-body px-2.5 py-1">−</button>
                  <span className="font-body px-1" style={{ fontSize: 12.5, minWidth: 20, textAlign: "center" }}>{l.qty}</span>
                  <button type="button" aria-label={`More ${l.sku}`} onClick={() => setLines((p) => p.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))} className="font-body px-2.5 py-1">+</button>
                </div>
                <span className="flex items-center gap-1 font-body" style={{ fontSize: 12 }}>
                  ₹<input value={l.price} inputMode="decimal" onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, price: e.target.value.replace(/[^\d.]/g, "") } : x)))} aria-label={`Price for ${l.sku}`} className="font-body text-right" style={{ width: 70, fontSize: 12.5, padding: "5px 6px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
                </span>
                <span className="font-display text-right" style={{ fontSize: 13.5, fontWeight: 600, minWidth: 72 }}>{formatINR(l.qty * (Number(l.price) || 0))}</span>
                <button type="button" onClick={() => setLines((p) => p.filter((_, j) => j !== i))} aria-label={`Remove ${l.sku}`}><Trash2 size={14} color={palette.mutedGreige} /></button>
              </div>
            );
          })}
        </div>
      )}

      {lines.length > 0 && (
        <>
          {/* Customer + terms */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name (optional)" className="font-body p-2" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
            <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Phone (optional)" inputMode="tel" className="font-body p-2" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
          </div>

          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Discount</span>
            {(["none", "percent", "absolute"] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDiscountType(d)} className="font-body uppercase" style={chip(discountType === d)}>{d === "none" ? "None" : d === "percent" ? "%" : "₹"}</button>
            ))}
            {discountType !== "none" && (
              <input value={discountValue} onChange={(e) => setDiscountValue(e.target.value.replace(/[^\d.]/g, ""))} placeholder={discountType === "percent" ? "%" : "₹"} inputMode="decimal" className="font-body text-right" style={{ width: 70, fontSize: 12, padding: "6px", border: "1px solid rgba(26,26,26,0.2)", background: "#fff" }} />
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>GST</span>
            <button type="button" onClick={() => setTaxMode("none")} className="font-body uppercase" style={chip(taxMode === "none")}>No GST</button>
            {[5, 12, 18].map((r) => (
              <button key={r} type="button" onClick={() => { setTaxRate(r); if (taxMode === "none") setTaxMode("inclusive"); }} className="font-body uppercase" style={chip(taxMode !== "none" && taxRate === r)}>{r}%</button>
            ))}
            {taxMode !== "none" && (
              <>
                <button type="button" onClick={() => setTaxMode("inclusive")} className="font-body uppercase" style={chip(taxMode === "inclusive")}>Incl.</button>
                <button type="button" onClick={() => setTaxMode("exclusive")} className="font-body uppercase" style={chip(taxMode === "exclusive")}>On top</button>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Payment</span>
            {["Cash", "UPI", "Card", "Other"].map((m) => (
              <button key={m} type="button" onClick={() => setPayMethod(m)} className="font-body uppercase" style={chip(payMethod === m)}>{m}</button>
            ))}
          </div>

          <label className="flex flex-col gap-1 mt-3" style={{ maxWidth: 260, display: editBill ? "none" : undefined }}>
            <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige }}>Bill date — leave empty for today</span>
            <input type="date" value={billDate} max={todayIst} onChange={(e) => setBillDate(e.target.value)} className="font-body p-2" style={{ fontSize: 12, border: "1px solid rgba(26,26,26,0.2)", background: "#fff", color: palette.black }} />
            {billDate && billDate !== todayIst && (
              <span className="font-body" style={{ fontSize: 10, color: palette.goldDeep }}>
                Past-dated: the bill number and reports will use {new Date(billDate + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.
              </span>
            )}
          </label>

          {/* Totals */}
          <div className="mt-4 p-3" style={{ background: palette.ivoryDeep }}>
            <div className="flex justify-between font-body" style={{ fontSize: 12, color: palette.softBlack }}>
              <span>Subtotal</span><span>{formatINR(subtotal)}</span>
            </div>
            {discountAmt > 0 && (
              <div className="flex justify-between font-body mt-1" style={{ fontSize: 12, color: palette.goldDeep }}>
                <span>Discount{discountType === "percent" ? ` (${discountNum}%)` : ""}</span><span>− {formatINR(discountAmt)}</span>
              </div>
            )}
            {taxMode === "exclusive" && (
              <div className="flex justify-between font-body mt-1" style={{ fontSize: 12, color: palette.softBlack }}>
                <span>GST @ {taxRate}%</span><span>{formatINR(taxAmt)}</span>
              </div>
            )}
            <div className="flex justify-between font-body mt-2" style={{ fontSize: 14, fontWeight: 700, color: palette.black }}>
              <span>TOTAL</span><span>{formatINR(grandTotal)}</span>
            </div>
            {taxMode === "inclusive" && (
              <div className="font-body text-right mt-0.5" style={{ fontSize: 10, color: palette.mutedGreige }}>includes GST @ {taxRate}% = {formatINR(taxAmt)}</div>
            )}
          </div>

          <button type="button" disabled={pending || lines.length === 0} onClick={save} className="mt-4 w-full font-body uppercase disabled:opacity-40" style={{ fontSize: 11, letterSpacing: "0.2em", background: palette.black, color: palette.ivory, padding: "14px 0", fontWeight: 600 }}>
            {pending ? "Saving…" : editBill ? `Update ${editBill.bill_number} · ${formatINR(grandTotal)}` : `Save retail bill · ${formatINR(grandTotal)}`}
          </button>
        </>
      )}

      {scanning && <QrScanner title="Retail billing" caption="Scan each garment's tag — it joins the bill at its retail price." onScan={handleScan} onClose={() => setScanning(false)} holdFeedback />}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 font-body px-4 py-2" style={{ background: palette.black, color: palette.ivory, fontSize: 12 }}>{toast}</div>
      )}
    </div>
  );
}
