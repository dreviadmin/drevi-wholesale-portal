"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus } from "lucide-react";
import { palette } from "@/lib/palette";
import {
  bucketChanges,
  heldBucketName,
  mergeBuckets,
  orderedBucketKeys,
  pickerBuckets,
  type BucketMark,
  type StudioBucket,
} from "@/lib/studio/buckets";
import { addStudioBucket } from "./bucket-actions";

// The Studio bucket picker (0074, several buckets per design since 0078). A
// checklist, not the native select it used to be: a native multiple select is
// a tall inline listbox on a laptop. On a phone it opens as a sheet from the
// bottom of the screen; wider, as a panel under (or above) its button. Either
// way it is portalled to <body>, so the board table's scroll box and the
// batch bar's stacking cannot clip it.

/**
 * The bucket list as this screen knows it: the server's list with anything
 * added or removed here layered on top, so a custom bucket shows in every
 * picker and filter chip the moment it is created — before any refresh.
 */
export function useBuckets(server: StudioBucket[]) {
  const [local, setLocal] = useState<StudioBucket[]>([]);
  // The overlay only bridges the gap until the server list catches up: every
  // add / remove revalidates the page, so the next server list already has
  // the change. Clearing it then means another admin's later remove or
  // restore is never masked by a stale local copy.
  useEffect(() => { setLocal([]); }, [server]);
  const buckets = useMemo(() => mergeBuckets(server, local), [server, local]);
  const remember = (b: StudioBucket) => setLocal((prev) => [...prev.filter((x) => x.key !== b.key), b]);

  /** Ask for a name, create (or reuse) the bucket. null = cancelled. */
  async function promptAndAdd(): Promise<{ bucket?: StudioBucket; error?: string; existed?: boolean } | null> {
    const label = window.prompt("Name the new bucket");
    if (label === null) return null;
    let r: Awaited<ReturnType<typeof addStudioBucket>> | undefined;
    try { r = await addStudioBucket(label); } catch { r = undefined; }
    if (!r?.ok || !r.bucket) return { error: r?.error ?? "Could not add the bucket — check the connection" };
    remember(r.bucket);
    return { bucket: r.bucket, existed: r.existed };
  }

  return { buckets, remember, promptAndAdd };
}

/** A save the picker can wait on: the error text, or nothing when it worked. */
type Save = Promise<string | null | void> | void;

const PANEL_WIDTH = 288;
const PHONE = "(max-width: 767px)";

/**
 * Open/close, with focus handed back to the button that opened it. onChange
 * also fires if the picker unmounts while open, so a parent holding something
 * for the open picker is always released.
 *
 * Closing can take the row itself off the board (a filter the design no
 * longer matches), so focus is handed back after that render: to the button
 * if it is still there, otherwise to onFocusLost.
 */
function usePanel(onChange?: (open: boolean) => void, onFocusLost?: () => void) {
  const [open, setOpenState] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const lostRef = useRef(onFocusLost);
  lostRef.current = onFocusLost;
  const openRef = useRef(false);
  const setOpen = (v: boolean) => { openRef.current = v; setOpenState(v); changeRef.current?.(v); };
  const close = () => {
    const button = trigger.current;
    const lost = lostRef.current;
    setOpen(false);
    button?.focus();
    requestAnimationFrame(() => { if (!button?.isConnected) lost?.(); });
  };
  useEffect(() => () => { if (openRef.current) changeRef.current?.(false); }, []);
  return { open, setOpen, trigger, close };
}

function Panel({ anchor, label, onClose, children, status, footer }: {
  anchor: HTMLElement | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** A failed save, shown inside the panel: on a phone the sheet covers the page's toast. */
  status?: string | null;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [phone] = useState(() => window.matchMedia(PHONE).matches);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  // Below the button when it fits, above when it does not (the batch bar sits
  // at the bottom of the screen), never past either edge.
  useLayoutEffect(() => {
    if (phone || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    setPos(below >= 260 || below >= above
      ? { left, top: r.bottom + 4, maxHeight: Math.max(180, below) }
      : { left, bottom: window.innerHeight - r.top + 4, maxHeight: Math.max(180, above) });
  }, [anchor, phone]);

  // The listeners outlive renders (every tick re-renders the picker), so they
  // call the latest onClose through a ref rather than re-subscribing, and
  // focus moves into the panel once, on open.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const placed = phone || !!pos;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [placed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeRef.current(); } };
    // A panel left floating over a list that has scrolled away from its button
    // reads as belonging to another row. Scrolling inside the panel is fine.
    const onScroll = (e: Event) => { if (!phone && !ref.current?.contains(e.target as Node)) closeRef.current(); };
    const onResize = () => { if (!phone) closeRef.current(); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [phone]);

  // Arrows move between the panel's controls. Left to the browser, they would
  // scroll the page, and a scroll closes the panel.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown"].includes(e.key)) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" || e.key === "PageUp" ? 0 : e.key === "End" || e.key === "PageDown" ? items.length - 1
      : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next].focus();
  }

  if (!phone && !pos) return null;
  const sheet = (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      // Clicks must not reach the table row underneath, which opens the design.
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col"
      style={{
        position: "fixed",
        zIndex: 70,
        background: palette.ivory,
        border: "1px solid rgba(26,26,26,0.14)",
        boxShadow: "0 10px 30px rgba(26,26,26,0.22)",
        ...(phone
          ? { left: 0, right: 0, bottom: 0, maxHeight: "72vh", paddingBottom: "env(safe-area-inset-bottom, 0px)" }
          : { left: pos!.left, top: pos!.top, bottom: pos!.bottom, width: PANEL_WIDTH, maxHeight: pos!.maxHeight }),
      }}
    >
      <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.16em", color: palette.mutedGreige, padding: "12px 14px 6px" }}>{label}</div>
      <div className="overflow-y-auto" style={{ flex: "1 1 auto", minHeight: 0 }}>{children}</div>
      {status && (
        <div role="alert" className="font-body" style={{ padding: "8px 14px", fontSize: 11.5, lineHeight: 1.45, color: palette.crimsonText, background: palette.crimsonSoft, borderTop: `1px solid ${palette.crimsonBorder}` }}>
          {status}
        </div>
      )}
      <div className="flex items-center gap-2" style={{ padding: "10px 12px", borderTop: "1px solid rgba(26,26,26,0.08)" }}>{footer}</div>
    </div>
  );
  return createPortal(
    <>
      <div
        aria-hidden
        onMouseDown={(e) => { e.preventDefault(); onClose(); }}
        onClick={(e) => e.stopPropagation()}
        style={{ position: "fixed", inset: 0, zIndex: 69, background: phone ? "rgba(26,26,26,0.35)" : "transparent" }}
      />
      {sheet}
    </>,
    document.body,
  );
}

function CheckRow({ label, checked, mixed, hint, unavailable, onChange }: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  hint?: string;
  /** Listed but cannot be ticked. aria-disabled, not disabled: focus stays on it. */
  unavailable?: boolean;
  onChange: () => void;
}) {
  const box = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = !!mixed; }, [mixed]);
  return (
    <label className="flex items-center gap-2.5 cursor-pointer font-body" style={{ padding: "9px 14px", minHeight: 42, fontSize: 12.5, color: palette.black }}>
      <input ref={box} type="checkbox" checked={checked} onChange={onChange} aria-disabled={unavailable || undefined} style={{ accentColor: palette.goldDeep, width: 16, height: 16, flex: "none", opacity: unavailable ? 0.45 : 1 }} />
      <span className="min-w-0 flex-1" style={{ overflowWrap: "anywhere" }}>{label}</span>
      {/* Visual only: a mixed checkbox already announces itself as mixed, and
          the hint inside the label would otherwise become part of its name. */}
      {hint && <span aria-hidden style={{ fontSize: 10.5, color: palette.mutedGreige, flex: "none" }}>{hint}</span>}
    </label>
  );
}

function AddRow({ onAdd }: { onAdd: () => void }) {
  return (
    <button type="button" onClick={onAdd} className="flex items-center gap-2 w-full text-left font-body" style={{ padding: "9px 14px", minHeight: 42, fontSize: 12, color: palette.goldDeep }}>
      <Plus size={14} /> Add custom…
    </button>
  );
}

const footerButton = (primary: boolean) => ({
  fontSize: 9.5, letterSpacing: "0.12em", padding: "9px 12px",
  background: primary ? palette.black : "transparent",
  color: primary ? palette.ivory : palette.softBlack,
  border: primary ? "none" : "1px solid rgba(26,26,26,0.2)",
});

/**
 * One design's buckets. Each tick saves at once and the panel stays open, so
 * a design can be put in two or three buckets in one go. A save that fails is
 * reported inside the panel and stays there until it closes.
 */
export function BucketPicker({ value, buckets, onToggle, onClear, onAdd, onOpenChange, onFocusLost, disabled, ariaLabel }: {
  value: string[];
  buckets: StudioBucket[];
  onToggle: (key: string, on: boolean) => Save;
  onClear: () => Save;
  onAdd: () => Save;
  /** The board holds a design's place in its filter and sort while this is open. */
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes if closing took this picker's row off the board. */
  onFocusLost?: () => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const { open, setOpen, trigger, close } = usePanel(onOpenChange, onFocusLost);
  const [error, setError] = useState<string | null>(null);
  // The options as they were on open: a removed bucket stays listed (unticked)
  // after it is taken off, so the row in focus never vanishes under the cursor.
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const held = orderedBucketKeys(value, buckets);
  const unset = held.length === 0;
  const names = held.map((k) => heldBucketName(k, buckets));
  // Two names fit a card; the rest are counted outside the truncated text, so a
  // narrow cell never hides that there are more. The title carries them all.
  const summary = unset ? "Not set" : names.slice(0, 2).join(", ");
  const more = held.length > 2 ? `+${held.length - 2}` : "";
  const options = pickerBuckets(buckets, [...openKeys, ...value]);
  const save = (s: Save) => { void Promise.resolve(s).then((e) => { if (e) setError(e); }); };
  const start = () => { setError(null); setOpenKeys(value); setOpen(true); };
  const finish = () => { setError(null); close(); };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`${ariaLabel}: ${unset ? "Not set" : names.join(", ")}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-bucket-trigger=""
        disabled={disabled}
        title={unset ? undefined : names.join(", ")}
        onClick={(e) => { e.stopPropagation(); start(); }}
        className="font-body flex items-center gap-1 disabled:opacity-50 text-left"
        style={{
          // minWidth 0: one 40-character custom bucket must not widen every card.
          fontSize: 11, padding: "5px 6px", maxWidth: "100%", minWidth: 0,
          border: `1px solid ${unset ? "rgba(26,26,26,0.15)" : palette.goldDeep}`,
          background: unset ? "#fff" : palette.ivoryDeep,
          color: unset ? palette.mutedGreige : palette.black,
          fontWeight: unset ? 400 : 600,
        }}
      >
        <span className="truncate">{summary}</span>
        {more && <span style={{ flex: "none", color: palette.goldDeep }}>{more}</span>}
        <ChevronDown size={12} style={{ flex: "none" }} />
      </button>
      {open && (
        <Panel
          anchor={trigger.current}
          label={ariaLabel}
          onClose={finish}
          status={error}
          footer={
            <>
              {/* Not disabled when empty: a control that disables itself under
                  the keyboard drops focus to the page. */}
              <button type="button" onClick={() => { if (!unset) save(onClear()); }} className="font-body uppercase" style={footerButton(false)}>Clear all</button>
              <span className="flex-1" />
              <button type="button" onClick={finish} className="font-body uppercase" style={footerButton(true)}>Done</button>
            </>
          }
        >
          {options.map((b) => {
            const on = value.includes(b.key);
            // A removed bucket stays listed after it is taken off, so focus has
            // somewhere to stay, but putting it back would only be refused.
            const unavailable = !b.active && !on;
            return (
              <CheckRow
                key={b.key}
                label={b.active ? b.label : `${b.label} (removed)`}
                checked={on}
                unavailable={unavailable}
                onChange={() => {
                  if (unavailable) { setError(`"${b.label}" was removed, so it can't be put back on designs. Add it again with Add custom… to use it.`); return; }
                  save(onToggle(b.key, !on));
                }}
              />
            );
          })}
          <AddRow onAdd={() => save(onAdd())} />
        </Panel>
      )}
    </>
  );
}

/**
 * Buckets for the designs selected on the board. A tick shows whether all,
 * some or none of them are in a bucket. Nothing saves until Apply, so several
 * buckets can be added and removed across the whole selection in one go, and
 * a bucket left as it was is not touched.
 *
 * Everything compares against the marks as they were on open, not the live
 * ones: a refresh while the panel is open (another admin, a finished job)
 * must not turn a bucket nobody touched into a change.
 */
export function BatchBucketPicker({ count, marks, buckets, onApply, onCreate, disabled }: {
  count: number;
  marks: Map<string, BucketMark>;
  buckets: StudioBucket[];
  onApply: (change: { add: string[]; remove: string[] }) => void;
  /** Create (or reuse) a bucket; it is ticked here and saved on Apply. */
  onCreate: () => Promise<StudioBucket | null>;
  disabled?: boolean;
}) {
  const { open, setOpen, trigger, close } = usePanel();
  const [initial, setInitial] = useState<Map<string, BucketMark>>(new Map());
  const [chosen, setChosen] = useState<Map<string, BucketMark>>(new Map());
  const [extra, setExtra] = useState<StudioBucket[]>([]);
  const start = () => { setInitial(new Map(marks)); setChosen(new Map(marks)); setExtra([]); setOpen(true); };

  const list = mergeBuckets(buckets, extra);
  const options = pickerBuckets(list, [...initial].filter(([, m]) => m !== "none").map(([k]) => k));
  const change = bucketChanges(initial, chosen);
  const pending = change.add.length + change.remove.length;
  const cycle = (b: StudioBucket) => setChosen((prev) => {
    const next = new Map(prev);
    const now = next.get(b.key) ?? "none";
    const was = initial.get(b.key) ?? "none";
    // A removed bucket can only be taken off, then put back as it was: adding
    // it to more designs would be refused and sink the whole Apply.
    if (!b.active) next.set(b.key, now === "none" ? was : "none");
    // A bucket that started mixed can go back to "leave as is".
    else next.set(b.key, now === "all" ? "none" : now === "none" && was === "some" ? "some" : "all");
    return next;
  });
  async function create() {
    const b = await onCreate();
    if (!b) return;
    setExtra((prev) => [...prev.filter((x) => x.key !== b.key), b]);
    setChosen((prev) => new Map(prev).set(b.key, "all"));
  }
  const many = count === 1 ? "1 design" : `${count} designs`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={start}
        className="font-body uppercase flex items-center gap-1 disabled:opacity-50"
        style={{ fontSize: 9, letterSpacing: "0.1em", padding: "8px 10px", color: palette.ivory, background: palette.black, border: `1px solid ${palette.champagne}` }}
      >
        Buckets… <ChevronDown size={11} />
      </button>
      {open && (
        <Panel
          anchor={trigger.current}
          label={`Buckets for ${many}`}
          onClose={close}
          footer={
            <>
              <button type="button" onClick={() => setChosen(new Map(options.map((b) => [b.key, "none" as BucketMark])))} className="font-body uppercase" style={footerButton(false)}>Clear all</button>
              <span className="flex-1" />
              <button type="button" onClick={close} className="font-body uppercase" style={footerButton(false)}>Cancel</button>
              <button
                type="button"
                disabled={pending === 0}
                onClick={() => { onApply(change); close(); }}
                className="font-body uppercase disabled:opacity-40"
                style={footerButton(true)}
              >
                Apply
              </button>
            </>
          }
        >
          {options.map((b) => {
            const mark = chosen.get(b.key) ?? "none";
            return (
              <CheckRow
                key={b.key}
                label={b.active ? b.label : `${b.label} (removed)`}
                checked={mark === "all"}
                mixed={mark === "some"}
                hint={mark === "some" ? "some" : undefined}
                onChange={() => cycle(b)}
              />
            );
          })}
          <AddRow onAdd={() => { void create(); }} />
        </Panel>
      )}
    </>
  );
}
