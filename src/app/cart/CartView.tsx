"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { ChevronLeft, Menu, Minus, Plus, X } from "lucide-react";
import { BuyerNavDrawer } from "@/components/BuyerNavDrawer";
import { useInAppBack } from "@/components/InAppHistory";
import { QtyField } from "@/components/QtyField";
import { setQty, setSpecialQty, removeFromCart, submitOrder, type SubmitState } from "./actions";
import { cartPieces } from "@/lib/cart-count";
import { CartQtySync } from "@/lib/cart-qty-sync";
import { formatINR } from "@/lib/format";
import { buyerVariantLabel } from "@/lib/variants";
import { palette } from "@/lib/palette";
import { uuid } from "@/lib/uuid";
import type { StockState } from "@/lib/types";

// cap / moq / stockState / restockDays / belowMoq are still sent by page.tsx
// but nothing here renders them — the buyer cart states no stock, no lead time
// and no minimum. They stay on the DTO so page.tsx keeps compiling.
interface CartLineDTO {
  sku: string;
  title: string;
  image: string | null;
  unitPrice: number;
  qty: number;
  cap: number | null;
  moq: number | null;
  stockState: StockState;
  restockDays: number | null;
  belowMoq: boolean;
  special: boolean;
  lineTotal: number;
}

function SubmitButton({ saving }: { saving: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={saving || pending}
      className="w-full font-body uppercase transition-opacity disabled:opacity-50"
      style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "14px 0" }}
    >
      {pending ? "Submitting…" : saving ? "Saving your cart…" : "Submit Order Request"}
    </button>
  );
}

export function CartView({
  lines,
  changeNotice = null,
  droppedSkus = [],
  adjustedLines = [],
}: {
  lines: CartLineDTO[];
  /** The server's subtotal; the screen adds up its own numbers, which can be newer. */
  subtotal: number;
  /** What changed since the buyer added it; never states a quantity. */
  changeNotice?: string | null;
  /** Stored rows the cart no longer shows, removed once the notice is up. */
  droppedSkus?: string[];
  /** Lines shown below their stored quantity, saved at what is shown. */
  adjustedLines?: { sku: string; qty: number }[];
  /**
   * Both still accepted so page.tsx keeps compiling, but neither renders: the
   * cart no longer quotes a lead time or gates the submit on a minimum. Rakesh
   * confirms the whole request on the call. Optional so page.tsx can stop
   * computing them without touching this file again.
   */
  maxLeadDays?: number;
}) {
  const router = useRouter();
  const back = useInAppBack("/catalog");
  const [menuOpen, setMenuOpen] = useState(false);
  const [state, formAction] = useFormState<SubmitState, FormData>(submitOrder, {});
  // One idempotency key per cart screen — retries of this submit resolve to
  // the same order server-side. uuid() and not a hand-rolled fallback: the old
  // one was 41 characters, which submitOrder's 36-character check drops, so
  // in-app browsers without randomUUID (WhatsApp, Instagram) lost the
  // double-submit protection entirely.
  const clientRefRef = useRef<string>(uuid());

  // Quantities on screen, one per line (Nov review). − and + used to grey out
  // for about two seconds while each save ran, and taps in that time were
  // lost. Now every tap moves this number at once; CartQtySync sends a line's
  // final number once the taps pause (~400 ms), one save at a time across the
  // cart, and never lets a reply or a refresh put back an older number over a
  // newer tap. Submit waits until everything is saved. A failed save puts its
  // line back to the saved number in the same tick Submit comes back.
  const [qtyBySku, setQtyBySku] = useState<Record<string, number>>(() => Object.fromEntries(lines.map((l) => [l.sku, l.qty])));
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Read by the save, which runs after the render that queued it.
  const specialRef = useRef(new Map<string, boolean>());
  specialRef.current = new Map(lines.map((l) => [l.sku, l.special]));

  const [sync] = useState(
    () =>
      new CartQtySync({
        // 0 removes the line. `special` still goes to setSpecialQty so a line a
        // buyer flagged before keeps its exact quantity on edit.
        save: async (sku, qty) =>
          (qty > 0 && specialRef.current.get(sku) ? await setSpecialQty(sku, qty) : await setQty(sku, Math.max(0, qty))).qty,
        onServerQty: (sku, qty) => { if (mounted.current) setQtyBySku((m) => ({ ...m, [sku]: qty })); },
        onError: () => {
          if (mounted.current) setSaveError("A change could not be saved. The cart now shows what is saved; please try again.");
        },
        // Only after a failure. Each save's reply already carries the fresh
        // cart (revalidatePath), and a refresh after every save sat in Next's
        // router queue: the next save queued behind it unsent, and Back or a
        // link then dropped it without a word (Nov review).
        onIdle: (failed) => { if (mounted.current && failed) router.refresh(); },
        onBusyChange: (b) => { if (mounted.current) setSaving(b); },
      }),
  );

  // A fresh cart from the server: take its numbers, except on a line the
  // buyer has changed since and is still saving. They are also what a failed
  // save goes back to.
  useEffect(() => {
    for (const l of lines) if (!sync.isDirty(l.sku)) sync.noteSaved(l.sku, l.qty);
    setQtyBySku((prev) => {
      const next: Record<string, number> = {};
      for (const l of lines) next[l.sku] = sync.isDirty(l.sku) && prev[l.sku] != null ? prev[l.sku] : l.qty;
      return next;
    });
    setRemoved((prev) => {
      const live = new Set(lines.map((l) => l.sku));
      const keep = new Set([...prev].filter((sku) => live.has(sku)));
      return keep.size === prev.size ? prev : keep;
    });
  }, [lines, sync]);

  // Leaving the cart (Back, a product, closing the tab) sends a waiting
  // number now rather than dropping it.
  useEffect(() => {
    mounted.current = true;
    const flush = () => sync.flush();
    const onHide = () => { if (document.visibilityState === "hidden") sync.flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      mounted.current = false;
      sync.flush();
    };
  }, [sync]);

  function editQty(sku: string, qty: number) {
    const q = Math.max(0, qty);
    setSaveError(null);
    setQtyBySku((m) => ({ ...m, [sku]: q }));
    sync.set(sku, q);
  }
  function remove(sku: string) {
    setSaveError(null);
    setRemoved((r) => new Set(r).add(sku));
    sync.cancel(sku);
    void sync.run(async () => {
      try {
        await removeFromCart(sku);
      } catch (err) {
        // Put the line back; the refresh shows what is really saved.
        if (mounted.current) setRemoved((r) => { const n = new Set(r); n.delete(sku); return n; });
        throw err;
      }
    });
  }

  const shown = lines
    .filter((l) => !removed.has(l.sku))
    .map((l) => {
      const qty = qtyBySku[l.sku] ?? l.qty;
      return { ...l, qty, lineTotal: qty * l.unitPrice };
    });
  const shownSubtotal = shown.reduce((s, l) => s + l.lineTotal, 0);

  // Say once what changed, then make the stored cart match what is shown so
  // the notice does not return on the next visit. Ordering already used the
  // shown lines, so nothing about the order changes. In the same one-at-a-time
  // line as the quantity saves: each call rewrites the whole cart row, and two
  // at once would lose one.
  const [notice] = useState(changeNotice);
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current) return;
    settled.current = true;
    if (droppedSkus.length === 0 && adjustedLines.length === 0) return;
    void sync.run(async () => {
      try {
        for (const sku of droppedSkus) await removeFromCart(sku);
        for (const a of adjustedLines) await setQty(a.sku, a.qty);
      } catch {
        // Nothing to undo: the notice simply shows again next visit.
      }
    }, { refresh: false });
    // Once per visit, from the props the page was rendered with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: palette.ivory }}>
      {/* The menu takes the slot the layout already held open opposite the
          back arrow, so the bar keeps its balance. */}
      <BuyerNavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} cartCount={cartPieces(shown.map((l) => l.qty))} className="sticky top-0 z-10">
        <div
          className="flex items-center justify-between px-4 py-3.5"
          style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}
        >
          {/* Back to wherever the cart was opened from (home, catalog, a
              product); straight to the catalog when nothing in the app is
              behind it. The negative margin widens the tap area to ~44px
              without moving the bar. */}
          <button type="button" onClick={back} aria-label="Back" className="flex items-center justify-center" style={{ color: palette.black, padding: 11, margin: -11 }}>
            <ChevronLeft size={22} strokeWidth={1.5} />
          </button>
          <div className="font-body uppercase" style={{ fontSize: 12, letterSpacing: "0.3em", color: palette.black }}>
            Cart
          </div>
          <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu" style={{ width: 22, color: palette.black }}>
            {menuOpen ? <X size={20} strokeWidth={1.5} /> : <Menu size={20} strokeWidth={1.5} />}
          </button>
        </div>
      </BuyerNavDrawer>

      {notice && (
        <div className="px-4 pt-4">
          <p role="status" className="font-body max-w-2xl mx-auto" style={{ background: palette.ivoryDeep, color: palette.softBlack, fontSize: 13, lineHeight: 1.6, padding: "12px 14px" }}>
            {notice}
          </p>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <p className="font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em", lineHeight: 1.8 }}>
            Your cart is empty.
          </p>
          <Link href="/catalog" className="font-body uppercase mt-4" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.2em", padding: "9px 18px" }}>
            Browse Catalog
          </Link>
        </div>
      ) : (
        <div className="flex-1 px-4 py-4">
          <div className="flex flex-col gap-3 max-w-2xl mx-auto">
            {shown.map((l) => (
              <div key={l.sku} className="flex gap-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
                <Link href={`/product/${encodeURIComponent(l.sku)}`} className="relative flex-shrink-0" style={{ width: 96, height: 171, background: palette.ivoryDeep }}>
                  {l.image && <Image src={l.image} alt={l.title} fill sizes="96px" className="object-cover" />}
                </Link>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/product/${encodeURIComponent(l.sku)}`} className="font-display" style={{ color: palette.black, fontSize: 14, lineHeight: 1.25, fontWeight: 500 }}>
                      {l.title}
                    </Link>
                    <button type="button" onClick={() => remove(l.sku)} aria-label="Remove" style={{ color: palette.mutedGreige }}>
                      <X size={16} strokeWidth={1.8} />
                    </button>
                  </div>
                  {/* Size and colour by name ("XL · Cream"); the SKU stays
                      under it for talking to Rakesh. */}
                  {buyerVariantLabel(l.sku) && (
                    <div className="font-body mt-0.5" style={{ color: palette.softBlack, fontSize: 12.5 }}>
                      {buyerVariantLabel(l.sku)}
                    </div>
                  )}
                  <div className="font-body mt-0.5 break-all" style={{ color: palette.mutedGreige, fontSize: 11, letterSpacing: "0.04em" }}>
                    {l.sku}
                  </div>

                  {/* The stepper runs free in both directions and never waits
                      for a save: l.qty is the number on screen, which every
                      tap moves at once (see CartQtySync above). − to 0 removes
                      the line once the taps pause. The number can be typed
                      too (24 pieces was 23 taps); typing 0 removes the line. */}
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center" style={{ border: `1px solid rgba(26,26,26,0.2)` }}>
                      <button type="button" disabled={l.qty <= 0} onClick={() => editQty(l.sku, l.qty - 1)} aria-label="Decrease" className="flex items-center justify-center disabled:opacity-50" style={{ color: palette.black, width: 40, height: 40 }}>
                        <Minus size={13} strokeWidth={2} />
                      </button>
                      <QtyField
                        value={l.qty}
                        min={0}
                        onCommit={(n) => (n === 0 ? remove(l.sku) : editQty(l.sku, n))}
                      />
                      <button type="button" onClick={() => editQty(l.sku, l.qty + 1)} aria-label="Increase" className="flex items-center justify-center disabled:opacity-50" style={{ color: palette.black, width: 40, height: 40 }}>
                        <Plus size={13} strokeWidth={2} />
                      </button>
                    </div>
                    <div className="font-display" style={{ color: palette.black, fontSize: 15, fontWeight: 600 }}>
                      {formatINR(l.lineTotal)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Summary + submit */}
          <div className="max-w-2xl mx-auto mt-6">
            <div className="flex items-baseline justify-between">
              <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>Subtotal</span>
              <span className="font-display" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>{formatINR(shownSubtotal)}</span>
            </div>

            <form action={formAction} className="mt-5">
              <input type="hidden" name="clientRef" value={clientRefRef.current} />
              <label className="block">
                <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}>Note (optional)</span>
                <textarea
                  name="note"
                  rows={2}
                  placeholder="Anything Rakesh should know about this order…"
                  className="w-full mt-1.5 font-body bg-transparent outline-none resize-none"
                  style={{ border: "1px solid rgba(26,26,26,0.2)", padding: "8px 10px", fontSize: 12.5, color: palette.black }}
                />
              </label>

              {saveError && (
                <p role="alert" className="font-body mt-2" style={{ fontSize: 11, color: palette.crimsonText }}>{saveError}</p>
              )}
              {state?.error && (
                <p className="font-body mt-2" style={{ fontSize: 11, color: palette.crimsonText }}>{state.error}</p>
              )}

              <div className="mt-2 p-3" style={{ background: palette.ivoryDeep }}>
                <p className="font-body" style={{ fontSize: 11.5, color: palette.softBlack, lineHeight: 1.7 }}>
                  Your order will be submitted to <strong>Drevi Fashion</strong>. Our admin will verify it
                  over a call <strong>within 24 hours</strong> and confirm. No payment is taken here —
                  submit your request now.
                </p>
              </div>
              <div className="mt-3">
                <SubmitButton saving={saving} />
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
