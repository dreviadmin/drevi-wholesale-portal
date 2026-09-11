"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { palette } from "@/lib/palette";
import { t, type StringKey } from "@/lib/strings";

// Back navigation (11 Sep): an explicit `?from=<same-origin path>` wins, else
// the page's own default. No history heuristics — `from` is validated before
// it ever becomes an href, so a pasted `?from=//evil` lands on the fallback.

interface BackLinkProps {
  fallback: string;
  fallbackLabel: string;
  className?: string;
  style?: React.CSSProperties;
}

const BASE_CLASS = "inline-flex items-center gap-1 font-body uppercase";
const BASE_STYLE = { fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige } as const;

/** Relative same-origin path only; anything else → null. */
export function safeFrom(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null;
  if (!/^\/(?![/\\])/.test(raw)) return null;
  if (raw.includes("://") || /javascript:/i.test(raw)) return null;
  return raw;
}

export function withFrom(href: string, from: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}from=${encodeURIComponent(from)}`;
}

/**
 * This page's own URL including the `?from=` it arrived with, for building
 * onward links — so a chain (Workbench → Specs → Product Master) unwinds hop
 * by hop instead of dropping the origin after the first page.
 */
export function useHere(ownPath: string): string {
  const params = useSearchParams();
  const from = safeFrom(params?.get("from"));
  return from ? withFrom(ownPath, from) : ownPath;
}

// Longest matching prefix wins; the query/hash is stripped before matching.
const LABELS: [string, StringKey][] = [
  ["/admin/studio/master/", "back.product_master"],
  ["/admin/studio/", "back.workbench"],
  ["/admin/studio", "nav.studio"],
  ["/admin/specs/", "nav.specs"],
  ["/admin/receipts/new", "nav.log_delivery"],
  ["/admin/receipts/", "back.receipt"],
  ["/admin/receipts", "nav.receipts"],
  ["/admin/vendors/", "back.vendor"],
  ["/admin/vendors", "nav.vendors"],
  ["/admin/buyers/", "back.buyer"],
  ["/admin/buyers", "nav.buyers"],
  ["/admin/orders/", "back.order"],
  ["/admin/orders", "nav.orders"],
  ["/admin/dashboard", "nav.dashboard"],
  ["/admin/home", "nav.home"],
];

export function labelFor(path: string): string {
  const clean = path.split(/[?#]/)[0];
  let best: StringKey | null = null;
  let bestLen = -1;
  for (const [prefix, key] of LABELS) {
    if (clean.startsWith(prefix) && prefix.length > bestLen) {
      best = key;
      bestLen = prefix.length;
    }
  }
  return t(best ?? "back.back");
}

function FallbackLink({ fallback, fallbackLabel, className, style }: BackLinkProps) {
  return (
    <Link href={fallback} className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS} style={{ ...BASE_STYLE, ...style }}>
      <ChevronLeft size={14} /> {fallbackLabel}
    </Link>
  );
}

function FromAwareLink(props: BackLinkProps) {
  const params = useSearchParams();
  const from = safeFrom(params?.get("from"));
  if (!from) return <FallbackLink {...props} />;
  return (
    <Link href={from} className={props.className ? `${BASE_CLASS} ${props.className}` : BASE_CLASS} style={{ ...BASE_STYLE, ...props.style }}>
      <ChevronLeft size={14} /> {labelFor(from)}
    </Link>
  );
}

export function BackLink(props: BackLinkProps) {
  // Every admin page is force-dynamic, but the boundary keeps a host page
  // that later turns static from failing the build on useSearchParams.
  return (
    <Suspense fallback={<FallbackLink {...props} />}>
      <FromAwareLink {...props} />
    </Suspense>
  );
}
