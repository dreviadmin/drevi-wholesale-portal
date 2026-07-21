"use client";

import { useRef, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { ChevronLeft, Minus, Plus, X } from "lucide-react";
import { setQty, setSpecialQty, removeFromCart, submitOrder, type SubmitState } from "./actions";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import type { StockState } from "@/lib/types";

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

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="w-full font-body uppercase transition-opacity disabled:opacity-50"
      style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "14px 0" }}
    >
      {pending ? "Submitting…" : "Submit Order Request"}
    </button>
  );
}

export function CartView({
  lines,
  subtotal,
  maxLeadDays,
  hasBlock,
}: {
  lines: CartLineDTO[];
  subtotal: number;
  maxLeadDays: number;
  hasBlock: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, formAction] = useFormState<SubmitState, FormData>(submitOrder, {});
  // One idempotency key per cart screen — retries of this submit resolve to
  // the same order server-side.
  const clientRefRef = useRef<string>(
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); }),
  );

  function editQty(sku: string, qty: number, special = false) {
    startTransition(async () => {
      if (special) await setSpecialQty(sku, qty);
      else await setQty(sku, qty);
      router.refresh();
    });
  }
  function requestSpecial(l: CartLineDTO) {
    const suggestion = l.belowMoq ? l.qty : (l.cap ?? l.qty) + 1;
    const answer = window.prompt("Special quantity request — how many pieces?", String(suggestion));
    if (answer === null) return;
    const wanted = Math.max(1, Math.floor(Number(answer) || 0));
    if (!wanted) return;
    editQty(l.sku, wanted, true);
  }
  function remove(sku: string) {
    startTransition(async () => {
      await removeFromCart(sku);
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: palette.ivory }}>
      <div
        className="flex items-center justify-between px-4 py-3.5 sticky top-0 z-10"
        style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.08)" }}
      >
        <Link href="/catalog" aria-label="Back to catalog" style={{ color: palette.black }}>
          <ChevronLeft size={22} strokeWidth={1.5} />
        </Link>
        <div className="font-body uppercase" style={{ fontSize: 12, letterSpacing: "0.3em", color: palette.black }}>
          Cart
        </div>
        <span style={{ width: 22 }} />
      </div>

      {lines.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <p className="font-body" style={{ color: palette.mutedGreige, fontSize: 12, letterSpacing: "0.1em", lineHeight: 1.8 }}>
            Your cart is empty.
          </p>
          <Link href="/catalog" className="font-body uppercase mt-4" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.2em", padding: "9px 18px" }}>
            Browse Catalog
          </Link>
        </div>
      ) : (
        <div className={`flex-1 px-4 py-4 ${isPending ? "opacity-90" : ""}`}>
          <div className="flex flex-col gap-3 max-w-2xl mx-auto">
            {lines.map((l) => {
              const atCap = !l.special && l.cap != null && l.qty >= l.cap;
              return (
                <div key={l.sku} className="flex gap-3 p-3" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
                  <Link href={`/product/${encodeURIComponent(l.sku)}`} className="relative flex-shrink-0" style={{ width: 96, height: 120, background: palette.ivoryDeep }}>
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
                    <div className="font-body mt-0.5" style={{ color: palette.mutedGreige, fontSize: 9, letterSpacing: "0.1em" }}>
                      {l.sku}
                    </div>

                    {l.stockState === "made_to_order" && (
                      <div className="font-body mt-1" style={{ color: palette.goldDeep, fontSize: 10, letterSpacing: "0.04em" }}>
                        Made to Order · {l.restockDays} days
                      </div>
                    )}

                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center" style={{ border: `1px solid rgba(26,26,26,0.2)` }}>
                        <button type="button" onClick={() => editQty(l.sku, l.qty - 1, l.special)} aria-label="Decrease" className="px-2.5 py-1.5" style={{ color: palette.black }}>
                          <Minus size={13} strokeWidth={2} />
                        </button>
                        <span className="font-body" style={{ minWidth: 28, textAlign: "center", fontSize: 13 }}>{l.qty}</span>
                        <button type="button" onClick={() => editQty(l.sku, l.qty + 1, l.special)} disabled={atCap} aria-label="Increase" className="px-2.5 py-1.5 disabled:opacity-40" style={{ color: palette.black }}>
                          <Plus size={13} strokeWidth={2} />
                        </button>
                      </div>
                      <div className="font-display" style={{ color: palette.black, fontSize: 15, fontWeight: 600 }}>
                        {formatINR(l.lineTotal)}
                      </div>
                    </div>

                    {l.special ? (
                      <div className="font-body mt-1.5" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.03em" }}>
                        Special quantity request — subject to Rakesh&apos;s confirmation.
                      </div>
                    ) : (
                      <>
                        {l.cap != null && (
                          <div className="font-body mt-1.5" style={{ fontSize: 10, color: palette.crimsonText, letterSpacing: "0.03em" }}>
                            Only {l.cap} available — not restockable.
                          </div>
                        )}
                        {l.belowMoq && (
                          <div className="font-body mt-1" style={{ fontSize: 10, color: palette.crimsonText, letterSpacing: "0.03em" }}>
                            Minimum {l.moq} pieces — increase to submit.
                          </div>
                        )}
                        {(l.belowMoq || atCap) && (
                          <button type="button" onClick={() => requestSpecial(l)} className="font-body uppercase mt-1.5" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.goldDeep, borderBottom: `1px solid ${palette.gold}` }}>
                            Request special quantity
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary + submit */}
          <div className="max-w-2xl mx-auto mt-6">
            <div className="flex items-baseline justify-between">
              <span className="font-body uppercase" style={{ fontSize: 11, letterSpacing: "0.18em", color: palette.softBlack }}>Subtotal</span>
              <span className="font-display" style={{ fontSize: 20, fontWeight: 600, color: palette.black }}>{formatINR(subtotal)}</span>
            </div>
            {maxLeadDays > 0 && (
              <div className="font-body mt-1 text-right" style={{ fontSize: 10, color: palette.goldDeep, letterSpacing: "0.04em" }}>
                Estimated availability: {maxLeadDays} days
              </div>
            )}

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

              {hasBlock && (
                <p className="font-body mt-2" style={{ fontSize: 11, color: palette.crimsonText }}>
                  Some items are below their minimum order quantity. Adjust them to submit.
                </p>
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
                <SubmitButton disabled={hasBlock || isPending} />
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
