"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

// Shared form-draft persistence. One hook replaces the hand-rolled
// restore-on-mount + write-on-change effect pairs. Rules it enforces:
//  - restore runs in an effect, never during render — every consumer is
//    server-rendered first, so a render-time localStorage read would be a
//    hydration mismatch;
//  - nothing is written until the restore for the current key has landed in
//    state, so `initial` can never clobber a stored draft;
//  - writes are debounced and flushed on pagehide / tab-hide / unmount
//    (iOS Safari kills background tabs without beforeunload);
//  - every storage access is wrapped — private mode and quota errors are silent.
// Envelope: { v, savedAt, base, data }. A payload without the envelope (the
// pre-hook drafts still on shop devices) is read as bare `data`.

export interface DraftOptions<T> {
  version?: number;                 // bump when T's shape changes; other versions are discarded
  ttlMs?: number;                   // default 7 days; older drafts discarded on read
  debounceMs?: number;              // default 300
  hasContent?: (s: T) => boolean;   // false => remove the stored draft instead of writing (blank form)
  base?: string | null;             // server snapshot the form was seeded from (updated_at or a JSON signature)
  enabled?: boolean;                // default true; false => behaves like plain useState
  onRestore?: (d: T) => T;          // merge hook applied to the stored data before it becomes state
}

export interface DraftMeta {
  restored: boolean;      // a draft was applied on mount (until dismiss()/clear())
  stale: boolean;         // restored AND envelope.base !== opts.base (server row changed since the draft)
  savedAt: number | null; // envelope savedAt at restore time; null for a pre-envelope draft
  clear: () => void;      // remove the stored draft; suppress the next write
  discard: () => void;    // clear() + reset state to `initial`
  dismiss: () => void;    // hide the notice, keep state
}

interface Envelope<T> { v: number; savedAt: number; base: string | null; data: T }

const DEFAULT_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 300;

function isEnvelope(x: unknown): x is Envelope<unknown> {
  if (!x || typeof x !== "object") return false;
  const e = x as Partial<Envelope<unknown>>;
  return typeof e.v === "number" && typeof e.savedAt === "number" && "data" in e;
}

function readDraft<T>(key: string, version: number, ttlMs: number): { data: T; savedAt: number | null; base: string | null } | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { return null; }
  if (raw == null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (isEnvelope(parsed)) {
    if (parsed.v !== version || Date.now() - parsed.savedAt > ttlMs) {
      removeDraft(key);
      return null;
    }
    return { data: parsed.data as T, savedAt: parsed.savedAt, base: parsed.base ?? null };
  }
  if (parsed == null) return null;
  return { data: parsed as T, savedAt: null, base: null };
}

function writeDraft<T>(key: string, version: number, base: string | null, data: T): void {
  try {
    const env: Envelope<T> = { v: version, savedAt: Date.now(), base, data };
    localStorage.setItem(key, JSON.stringify(env));
  } catch { /* quota / private mode — the form still works */ }
}

function removeDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function resolveInitial<T>(initial: T | (() => T)): T {
  return typeof initial === "function" ? (initial as () => T)() : initial;
}

const EMPTY_META = { restored: false, stale: false, savedAt: null as number | null };

export function useDraft<T>(
  key: string | null,
  initial: T | (() => T),
  opts: DraftOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>, DraftMeta] {
  const [state, setState] = useState<T>(initial);
  const [metaState, setMetaState] = useState(EMPTY_META);
  const enabled = opts.enabled !== false && key != null;

  // Latest-value refs: `initial`/`opts` are read inside effects without being deps.
  const initialRef = useRef(initial);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const keyRef = useRef(key);
  keyRef.current = key;
  const firstStateRef = useRef(state);

  const hydratedForRef = useRef<string | null>(null);                 // key whose restore effect has run
  const restoredRef = useRef<{ key: string; data: T } | null>(null);   // restored value not yet observed by the write effect
  const suppressRef = useRef(false);
  const prevKeyRef = useRef<string | null | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ key: string; version: number; base: string | null; data: T } | null>(null);

  const cancelPending = useCallback(() => {
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRef.current = null;
  }, []);

  const flush = useCallback(() => {
    const p = pendingRef.current;
    cancelPending();
    if (p) writeDraft(p.key, p.version, p.base, p.data);
  }, [cancelPending]);

  // Restore — once per key, in an effect.
  useEffect(() => {
    const keyChanged = prevKeyRef.current !== undefined && prevKeyRef.current !== key;
    prevKeyRef.current = key;
    flush(); // a write still pending for the previous key lands on that key
    restoredRef.current = null;
    suppressRef.current = false;
    if (!enabled || key == null) {
      hydratedForRef.current = null;
      if (keyChanged) setMetaState(EMPTY_META);
      return;
    }
    const o = optsRef.current;
    const found = readDraft<T>(key, o.version ?? DEFAULT_VERSION, o.ttlMs ?? DEFAULT_TTL_MS);
    if (found) {
      const data = o.onRestore ? o.onRestore(found.data) : found.data;
      restoredRef.current = { key, data };
      setState(data);
      setMetaState({ restored: true, stale: found.base !== (o.base ?? null), savedAt: found.savedAt });
    } else if (keyChanged) {
      setState(resolveInitial(initialRef.current));
      setMetaState(EMPTY_META);
    }
    hydratedForRef.current = key;
  }, [key, enabled, flush]);

  // Write — debounced; gated until the restore for this key has landed.
  useEffect(() => {
    if (!enabled || key == null) return;
    if (hydratedForRef.current !== key) return;
    const r = restoredRef.current;
    if (r && r.key === key) {
      if (state !== r.data) return; // the restore setState has not landed yet
      restoredRef.current = null;   // landed — don't re-write the identical draft (keeps savedAt honest)
      return;
    }
    if (suppressRef.current) { suppressRef.current = false; return; }
    const o = optsRef.current;
    if (state === firstStateRef.current || (o.hasContent && !o.hasContent(state))) {
      cancelPending();
      removeDraft(key);
      return;
    }
    if (timerRef.current != null) clearTimeout(timerRef.current);
    pendingRef.current = { key, version: o.version ?? DEFAULT_VERSION, base: o.base ?? null, data: state };
    timerRef.current = setTimeout(flush, o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }, [state, key, enabled, flush, cancelPending]);

  // Flush on tab-hide / pagehide / unmount so a debounced write is never lost.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [flush]);

  const clear = useCallback(() => {
    cancelPending();
    suppressRef.current = true;
    restoredRef.current = null;
    if (keyRef.current != null) removeDraft(keyRef.current);
    setMetaState((m) => (m.restored ? EMPTY_META : m));
  }, [cancelPending]);

  const discard = useCallback(() => {
    clear();
    setState(resolveInitial(initialRef.current));
  }, [clear]);

  const dismiss = useCallback(() => {
    setMetaState((m) => (m.restored ? { ...m, restored: false, stale: false } : m));
  }, []);

  const meta = useMemo<DraftMeta>(
    () => ({ restored: metaState.restored, stale: metaState.stale, savedAt: metaState.savedAt, clear, discard, dismiss }),
    [metaState, clear, discard, dismiss],
  );

  return [state, setState, meta];
}

// Create-form notice policy: restore silently unless the draft is old enough
// that "why is yesterday's form here" needs explaining.
export const DRAFT_NOTICE_AFTER_MS = 60 * 60 * 1000;
export function isDraftOlderThan(meta: DraftMeta, ms: number): boolean {
  return meta.restored && meta.savedAt !== null && Date.now() - meta.savedAt > ms;
}
