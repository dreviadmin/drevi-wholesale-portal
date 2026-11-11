// Saving cart quantities without dropping taps (Nov review). The cart used to
// grey out − and + for about two seconds while each save ran, so quick taps
// were lost. Now every tap changes the line's number on screen at once, and
// this sends the line's final number once the taps stop.
//
//  · Debounced per line: taps within `delayMs` of each other send one save,
//    with the last number.
//  · One save at a time across the whole cart: each save rewrites the whole
//    cart row, so two at once could lose one.
//  · A save a newer number has overtaken is skipped, and its reply is ignored:
//    a server reply never puts back an older number over a newer tap. A reply
//    for the newest number is passed on, so a server clamp still shows.
//  · flush() sends every waiting number now (leaving the page, unmount).
//  · A failed save puts its line back to the number the server still holds
//    (noteSaved, then every save's reply), unless a newer tap is on its way.
//    The screen then never offers Submit beside a number that was not saved.
//  · onIdle says whether anything failed. A save's reply already carries the
//    fresh page (revalidatePath), so the cart reloads only after a failure: a
//    reload after every save let Next drop the next save when the buyer left
//    while it ran (Nov review; see src/lib/catalog-card-saves.ts for how).
//
// No React here, so vitest can drive it with fake timers.

export type CartSaveFn = (sku: string, qty: number) => Promise<number>;

export interface CartQtySyncOptions {
  /** Sends one line's quantity; resolves with the quantity the server stored. */
  save: CartSaveFn;
  /**
   * Show this number for the line: the server stored a different number for
   * the newest tap (a clamp), or the newest tap's save failed and this is what
   * the server still holds.
   */
  onServerQty?: (sku: string, qty: number) => void;
  /** A save or task failed. */
  onError?: (sku: string | null, err: unknown) => void;
  /**
   * Nothing is waiting or in flight any more, after a save or a refreshing
   * task. `failed` is true when any of them failed since the last idle.
   */
  onIdle?: (failed: boolean) => void;
  /** Becomes true on the first waiting change, false when all are done. */
  onBusyChange?: (busy: boolean) => void;
  delayMs?: number;
}

export const CART_SAVE_DELAY_MS = 400;

export class CartQtySync {
  private readonly opts: CartQtySyncOptions;
  private readonly delayMs: number;
  /** Version of each line's newest local number; bumped by set() and cancel(). */
  private readonly version = new Map<string, number>();
  private readonly timers = new Map<string, { handle: ReturnType<typeof setTimeout>; qty: number; v: number }>();
  /** Saves queued or running, per line. */
  private readonly inFlight = new Map<string, number>();
  /** The number the server holds for each line, as far as this screen knows. */
  private readonly saved = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private tasks = 0;
  private wantsRefresh = false;
  private failedSinceIdle = false;
  private wasBusy = false;

  constructor(opts: CartQtySyncOptions) {
    this.opts = opts;
    this.delayMs = opts.delayMs ?? CART_SAVE_DELAY_MS;
  }

  /** A tap or a typed number: remembered at once, sent after the pause. */
  set(sku: string, qty: number): void {
    const v = this.bump(sku);
    const old = this.timers.get(sku);
    if (old) clearTimeout(old.handle);
    const handle = setTimeout(() => this.fire(sku), this.delayMs);
    this.timers.set(sku, { handle, qty, v });
    this.busyChanged();
  }

  /** Forget a line's waiting number and ignore any reply still on its way (Remove). */
  cancel(sku: string): void {
    this.bump(sku);
    const t = this.timers.get(sku);
    if (t) clearTimeout(t.handle);
    this.timers.delete(sku);
    this.busyChanged();
  }

  /** Send every waiting number now instead of after the pause. */
  flush(): void {
    for (const sku of [...this.timers.keys()]) this.fire(sku);
  }

  /**
   * Run other cart writes (remove a line, settle the change notice) in the
   * same one-at-a-time line as the saves. `refresh` asks for onIdle after it.
   */
  run(task: () => Promise<void>, { refresh = true }: { refresh?: boolean } = {}): Promise<void> {
    return this.enqueue(null, async () => {
      await task();
      if (refresh) this.wantsRefresh = true;
    });
  }

  /** What the server holds for a line, from the page it rendered. A failed save goes back to it. */
  noteSaved(sku: string, qty: number): void {
    this.saved.set(sku, qty);
  }

  /** The number the server holds for the line, if known (noteSaved or a save's reply). */
  savedQty(sku: string): number | undefined {
    return this.saved.get(sku);
  }

  /** True while the line has a number waiting or a save queued or running. */
  isDirty(sku: string): boolean {
    return this.timers.has(sku) || (this.inFlight.get(sku) ?? 0) > 0;
  }

  get busy(): boolean {
    return this.timers.size > 0 || this.tasks > 0;
  }

  private bump(sku: string): number {
    const v = (this.version.get(sku) ?? 0) + 1;
    this.version.set(sku, v);
    return v;
  }

  private fire(sku: string): void {
    const t = this.timers.get(sku);
    if (!t) return;
    clearTimeout(t.handle);
    this.timers.delete(sku);
    const { qty, v } = t;
    this.inFlight.set(sku, (this.inFlight.get(sku) ?? 0) + 1);
    void this.enqueue(sku, async () => {
      try {
        // Overtaken while it waited in line: the newer number goes instead.
        if (this.version.get(sku) !== v) return;
        let stored: number;
        try {
          stored = await this.opts.save(sku, qty);
        } catch (err) {
          // Still the newest number for the line: show what the server holds
          // again, in the same tick that ends the busy state.
          const back = this.saved.get(sku);
          if (this.version.get(sku) === v && back !== undefined && back !== qty) this.opts.onServerQty?.(sku, back);
          throw err;
        }
        this.saved.set(sku, stored);
        this.wantsRefresh = true;
        if (this.version.get(sku) === v && stored !== qty) this.opts.onServerQty?.(sku, stored);
      } finally {
        this.inFlight.set(sku, (this.inFlight.get(sku) ?? 1) - 1);
      }
    });
  }

  private enqueue(sku: string | null, job: () => Promise<void>): Promise<void> {
    this.tasks++;
    this.busyChanged();
    const run = this.chain.then(async () => {
      try {
        await job();
      } catch (err) {
        this.wantsRefresh = true;
        this.failedSinceIdle = true;
        this.opts.onError?.(sku, err);
      } finally {
        this.tasks--;
        this.settle();
      }
    });
    this.chain = run;
    return run;
  }

  private settle(): void {
    this.busyChanged();
    if (this.busy || !this.wantsRefresh) return;
    const failed = this.failedSinceIdle;
    this.wantsRefresh = false;
    this.failedSinceIdle = false;
    this.opts.onIdle?.(failed);
  }

  private busyChanged(): void {
    const b = this.busy;
    if (b === this.wasBusy) return;
    this.wasBusy = b;
    this.opts.onBusyChange?.(b);
  }
}
