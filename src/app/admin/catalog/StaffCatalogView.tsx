"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X, ScanLine, RefreshCw } from "lucide-react";
import { GroupedProductCard } from "@/components/GroupedProductCard";
import { ProductQuickView } from "@/components/ProductQuickView";
import { QrScanner, type ScanFeedback } from "@/components/QrScanner";
import { resyncCatalog } from "./actions";
import { groupByBase } from "@/lib/variants";
import { palette } from "@/lib/palette";
import type { WholesaleProduct } from "@/lib/types";

const PREFERRED = ["Lehenga", "Saree", "Indo-Western Set", "Suit Set", "Separates"];

export function StaffCatalogView({ products, hiddenSkus = [], lastSynced = null }: { products: WholesaleProduct[]; hiddenSkus?: string[]; lastSynced?: string | null }) {
  const router = useRouter();
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<WholesaleProduct | null>(null);
  const [scanning, setScanning] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [isSyncing, startSync] = useTransition();

  function doSync() {
    setSyncMsg(null);
    startSync(async () => {
      const res = await resyncCatalog();
      if (!res.ok) { setSyncMsg(res.error ?? "Sync failed — try again."); return; }
      setSyncMsg(
        `Synced ${res.synced} products · ${res.imageFetches} photo${res.imageFetches === 1 ? "" : "s"} refreshed` +
          (res.hidden ? ` · ${res.hidden} hidden` : "") +
          (res.warnings?.length ? ` · ${res.warnings.length} warning(s)` : ""),
      );
      router.refresh();
    });
  }

  const bySku = useMemo(
    () => new Map(products.map((p) => [p.sku.trim().toUpperCase(), p])),
    [products],
  );
  const hidden = useMemo(() => new Set(hiddenSkus.map((s) => s.trim().toUpperCase())), [hiddenSkus]);

  // Golden rule: every search has a scan. A hit opens the product straight away.
  function handleScan(text: string): ScanFeedback {
    const sku = text.trim().toUpperCase();
    const p = bySku.get(sku);
    if (!p) {
      return hidden.has(sku)
        ? { ok: false, message: `${sku} — hidden from the catalog (unhide it in Manage Catalog)` }
        : { ok: false, message: `${sku || "Empty scan"} — not on the portal` };
    }
    setScanning(false);
    setDetail(p);
    return { ok: true, message: p.title ?? p.sku };
  }

  const categories = useMemo(() => {
    const present = new Set(products.map((p) => p.category).filter((c): c is string => !!c));
    return ["All", ...PREFERRED.filter((c) => present.has(c)), ...Array.from(present).filter((c) => !PREFERRED.includes(c)).sort()];
  }, [products]);

  const filtered = useMemo(() => {
    let list = category === "All" ? products : products.filter((p) => p.category === category);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => (p.title?.toLowerCase().includes(q) ?? false) || p.sku.toLowerCase().includes(q) || (p.color?.toLowerCase().includes(q) ?? false));
    return list;
  }, [products, category, query]);

  const groups = useMemo(() => groupByBase(filtered), [filtered]);

  return (
    <div className="px-4 md:px-6 py-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Catalog</h1>
          <p className="font-body mt-1" style={{ fontSize: 12, color: palette.mutedGreige }}>
            {products.length} products · browse and search — tap any outfit for details.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={doSync}
            disabled={isSyncing}
            className="flex items-center gap-2 font-body uppercase disabled:opacity-60"
            style={{ fontSize: 9.5, letterSpacing: "0.14em", padding: "8px 13px", border: `1px solid ${palette.black}`, color: palette.black, background: "transparent" }}
          >
            <RefreshCw size={13} strokeWidth={1.8} className={isSyncing ? "animate-spin" : undefined} />
            {isSyncing ? "Syncing…" : "Sync from Sheet"}
          </button>
          {lastSynced && !syncMsg && (
            <span className="font-body" style={{ fontSize: 9, color: palette.mutedGreige }}>
              synced {new Date(lastSynced).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            </span>
          )}
        </div>
      </div>
      {syncMsg && <p className="font-body mt-2" style={{ fontSize: 11, color: syncMsg.includes("failed") ? palette.crimsonText : palette.goldDeep }}>{syncMsg}</p>}

      <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-4">
        {categories.map((c) => {
          const active = c === category;
          return (
            <button key={c} type="button" onClick={() => setCategory(c)} className="font-body uppercase whitespace-nowrap" style={{ color: active ? palette.ivory : palette.softBlack, background: active ? palette.black : "transparent", border: active ? "none" : "1px solid rgba(26,26,26,0.18)", padding: "6px 12px", fontSize: 10, letterSpacing: "0.15em" }}>
              {c}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 max-w-md" style={{ border: "1px solid rgba(26,26,26,0.18)", padding: "7px 10px" }}>
        <Search size={15} color={palette.mutedGreige} strokeWidth={1.7} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, SKU or colour"
          className="font-body bg-transparent outline-none w-full"
          style={{ fontSize: 12.5, color: palette.black }}
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <X size={14} color={palette.mutedGreige} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setScanning(true)}
          aria-label="Scan a tag"
          className="flex items-center gap-1.5 font-body uppercase flex-shrink-0"
          style={{ fontSize: 9, letterSpacing: "0.12em", padding: "6px 10px", background: palette.black, color: palette.ivory }}
        >
          <ScanLine size={13} strokeWidth={1.7} /> Scan
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="font-body mt-6" style={{ fontSize: 12, color: palette.mutedGreige }}>No designs match{query.trim() ? ` “${query.trim()}”` : ""}.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-4">
          {groups.map((g) => (
            <GroupedProductCard
              key={g.base}
              variants={g.variants}
              cartBySku={{}}
              onChangeQty={() => {}}
              readOnly
              onOpenDetail={setDetail}
            />
          ))}
        </div>
      )}

      {detail && <ProductQuickView product={detail} onClose={() => setDetail(null)} readOnly />}

      {scanning && <QrScanner title="Scan a tag" onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}
