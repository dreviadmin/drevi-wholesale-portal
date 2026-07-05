"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { X, Plus, Search, ScanLine } from "lucide-react";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { updateOrderItems, type OrderEditLine } from "@/app/admin/orders/actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { DiscountType, OrderItem, TaxMode } from "@/lib/types";

export interface PickerProduct {
  sku: string;
  title: string | null;
  wholesale_price: number;
  image_url: string | null;
}

interface DraftLine {
  key: string;
  kind: "keep" | "add";
  index?: number; // position in the stored items array (keep lines)
  sku: string;
  title: string;
  image_url: string | null;
  qty: string;
  unitPrice: string;
  actualQty: string; // blank = no GST split
  catalogPrice: number | null;
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
}: {
  orderId: string;
  status: string;
  items: OrderItem[];
  products: PickerProduct[];
  discountType: DiscountType | null;
  discountValue: number | null;
  taxMode: TaxMode | null;
  taxRate: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [isPending, start] = useTransition();

  // The scanner's camera loop captures the first render's onScan, so state
  // must be read through this ref (its identity is stable across renders).
  const linesRef = useRef<DraftLine[]>(lines);
  linesRef.current = lines;

  const productBySku = useMemo(
    () => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])),
    [products],
  );

  function openEditor() {
    setLines(
      items.map((it, i) => ({
        key: `keep-${i}`,
        kind: "keep",
        index: i,
        sku: it.sku,
        title: it.title,
        image_url: it.image_url ?? null,
        qty: String(it.qty),
        unitPrice: String(it.unit_price),
        actualQty: it.actual_qty != null ? String(it.actual_qty) : "",
        catalogPrice: null,
      })),
    );
    setQuery("");
    setError(null);
    setOpen(true);
  }

  function patch(key: string, field: "qty" | "unitPrice" | "actualQty", value: string) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }

  function addProduct(p: PickerProduct) {
    setLines((ls) => [
      ...ls,
      {
        key: `add-${p.sku}-${ls.length}`,
        kind: "add",
        sku: p.sku,
        title: p.title ?? p.sku,
        image_url: p.image_url,
        qty: "1",
        unitPrice: String(p.wholesale_price),
        actualQty: "",
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

  // Live preview with the order's existing discount/tax terms — the server
  // recomputes authoritatively on save.
  const preview = useMemo(() => {
    const subtotal = lines.reduce((s, l) => s + (Math.max(1, Math.floor(Number(l.qty) || 1)) * Math.max(0, Number(l.unitPrice) || 0)), 0);
    let discount = 0;
    if (discountType) {
      const v = Math.max(0, Number(discountValue) || 0);
      discount = discountType === "percent" ? (subtotal * Math.min(100, v)) / 100 : Math.min(subtotal, v);
    }
    const net = subtotal - discount;
    const rate = Number(taxRate) || 0;
    const tax = taxMode === "exclusive" ? (net * rate) / 100 : taxMode === "inclusive" ? (net * rate) / (100 + rate) : 0;
    const total = taxMode === "exclusive" ? net + tax : net;
    return { subtotal, discount, tax, total };
  }, [lines, discountType, discountValue, taxMode, taxRate]);

  function save() {
    setError(null);
    const payload: OrderEditLine[] = lines.map((l) =>
      l.kind === "keep"
        ? { kind: "keep", index: l.index!, qty: Number(l.qty) || 1, unitPrice: Number(l.unitPrice) || 0, actualQty: l.actualQty.trim() === "" ? null : Number(l.actualQty) }
        : { kind: "add", sku: l.sku, qty: Number(l.qty) || 1, unitPrice: Number(l.unitPrice) || 0, actualQty: l.actualQty.trim() === "" ? null : Number(l.actualQty) },
    );
    start(async () => {
      const res = await updateOrderItems(orderId, payload);
      if (!res.ok) { setError(res.error ?? "Failed to save"); return; }
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
            className="w-full sm:max-w-xl max-h-[90vh] overflow-y-auto"
            style={{ background: palette.ivory, padding: "20px 18px" }}
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
                    <div className="relative flex-shrink-0" style={{ width: 40, height: 50, background: palette.ivoryDeep }}>
                      {l.image_url && <Image src={l.image_url} alt={l.title} fill sizes="40px" className="object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-display truncate" style={{ fontSize: 13, color: palette.black, fontWeight: 500 }}>{l.title}</div>
                      <div className="font-body" style={{ fontSize: 8.5, color: palette.mutedGreige, letterSpacing: "0.1em" }}>{l.sku}{l.kind === "add" ? " · NEW" : ""}</div>
                    </div>
                    <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.sku}`} className="p-1">
                      <X size={14} color={palette.mutedGreige} />
                    </button>
                  </div>
                  <div className="flex items-end gap-4 mt-2 flex-wrap" style={{ paddingLeft: 52 }}>
                    <div>{label("Qty (billed)")}{numInput(l.qty, (v) => patch(l.key, "qty", v), 56)}</div>
                    <div>{label("Unit price ₹")}{numInput(l.unitPrice, (v) => patch(l.key, "unitPrice", v), 84)}</div>
                    <div>{label("Actual pcs (split)")}{numInput(l.actualQty, (v) => patch(l.key, "actualQty", v), 56, "—")}</div>
                    <div className="ml-auto text-right">
                      {label("Line total")}
                      <span className="font-display" style={{ fontSize: 14, fontWeight: 600, color: palette.black }}>
                        {formatINR((Math.max(1, Math.floor(Number(l.qty) || 1))) * (Math.max(0, Number(l.unitPrice) || 0)))}
                      </span>
                    </div>
                  </div>
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
            </div>

            <div className="mt-5 font-body" style={{ fontSize: 12, color: palette.softBlack }}>
              <div className="flex justify-between"><span>Subtotal</span><span>{formatINR(preview.subtotal)}</span></div>
              {preview.discount > 0 && (
                <div className="flex justify-between mt-1" style={{ color: palette.goldDeep }}>
                  <span>Discount{discountType === "percent" ? ` (${discountValue}%)` : ""}</span><span>− {formatINR(preview.discount)}</span>
                </div>
              )}
              {taxMode === "exclusive" && <div className="flex justify-between mt-1"><span>GST @ {taxRate}% (added)</span><span>{formatINR(preview.tax)}</span></div>}
              <div className="flex justify-between items-baseline mt-2">
                <span className="uppercase" style={{ fontSize: 10, letterSpacing: "0.18em" }}>New total</span>
                <span className="font-display" style={{ fontSize: 19, fontWeight: 600, color: palette.black }}>{formatINR(preview.total)}</span>
              </div>
              {taxMode === "inclusive" && <div className="text-right mt-0.5" style={{ fontSize: 9.5, color: palette.mutedGreige }}>includes GST @ {taxRate}% = {formatINR(preview.tax)}</div>}
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
              Saving regenerates the invoice PDF with the new figures. Leave “Actual pcs” blank unless the line is a GST bill-split.
            </p>
          </div>
        </div>
      )}

      {scanning && <QrScanner title="Scan to add items" onScan={handleAddScan} onClose={() => setScanning(false)} />}
    </>
  );
}
