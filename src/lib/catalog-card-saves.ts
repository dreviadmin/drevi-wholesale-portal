// Card quantity saves on the buyer catalog (Nov review).
//
// Each tap on a card used to start its own server action. Next 14.2 runs
// server actions one at a time in its router queue, and a navigation or a
// history write cuts that queue: the action already running is let go (its
// reply still arrives), but every action waiting behind it is dropped. It is
// never sent, and its promise never settles
// (next/dist/shared/lib/router/action-queue.js, dispatchAction). The catalog
// writes its filters into the address with history.replaceState, which Next
// patches into such a cut (ACTION_RESTORE, client/components/app-router.js).
// So a chip tap or a search pause while two taps were still saving lost the
// second one: the card said 2, the cart held 1, and nothing said so. A link
// or "Go to cart" did the same.
//
// What this does instead:
//  · Card saves go one at a time through CartQtySync with no pause: the next
//    is handed to Next only once the last has answered, so Next's queue never
//    holds a card save that has not been sent. Quick taps on one size send
//    only the newest number.
//  · While a save is outstanding, the address is not written and a link or
//    button that leaves the page is held. Both go once the last save has
//    answered, the address first. So nothing this page starts can cut a save.
//  · A failed save puts the card back to what the server holds and says so,
//    and a navigation held behind it is dropped so the buyer sees that.
//
// No React here, so vitest can drive it with fake timers.

import { CartQtySync } from "./cart-qty-sync";
import { cartReplyToast } from "./cart-toast";

export const CARD_SAVE_ERROR = "Could not update your cart. Please try again.";
export const CARD_SAVE_WAIT = "Saving your cart…";

export interface CatalogCardSavesOptions {
  /** Sends one line's quantity (0 removes it); resolves with what the server stored. */
  save: (sku: string, qty: number) => Promise<number>;
  /** Put this number on the card (0 = not in the cart). */
  showLine: (sku: string, qty: number) => void;
  toast: (message: string) => void;
  /** history.replaceState with the catalog's filters. */
  replaceUrl: (href: string) => void;
  /** router.push. */
  navigate: (href: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

export class CatalogCardSaves {
  private readonly opts: CatalogCardSavesOptions;
  private readonly sync: CartQtySync;
  private owedUrl: string | null = null;
  private heldNav: string | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private active = true;

  constructor(opts: CatalogCardSavesOptions) {
    this.opts = opts;
    this.sync = new CartQtySync({
      delayMs: 0,
      save: async (sku, qty) => {
        const before = this.sync.savedQty(sku) ?? 0;
        const stored = await opts.save(sku, qty);
        // "Added to cart" only once the server has the line; a size that just
        // sold out says only that it is no longer available.
        const msg = cartReplyToast(before, qty, stored);
        if (msg && this.active) opts.toast(msg);
        return stored;
      },
      onServerQty: (sku, qty) => { if (this.active) opts.showLine(sku, qty); },
      onError: () => {
        // Stay on the page, so the buyer sees the card go back and why.
        this.heldNav = null;
        if (this.active) opts.toast(CARD_SAVE_ERROR);
      },
      onBusyChange: (busy) => {
        if (this.active) opts.onBusyChange?.(busy);
        // A macrotask later, not now: Next settles the save's promise a few
        // microtasks before it lets go of the action, and a history write in
        // between would still cut it (and refetch the whole page).
        if (!busy && !this.releaseTimer) this.releaseTimer = setTimeout(() => this.release(), 0);
      },
    });
  }

  /** A save is outstanding, or the address and a held navigation are about to go. */
  get holding(): boolean {
    return this.sync.busy || this.releaseTimer != null;
  }

  /**
   * A tap on a card; the card already shows `qty`. `shownBefore` is the card's
   * number before the tap, which is the server's until the line is first saved.
   */
  change(sku: string, qty: number, shownBefore: number): void {
    if (this.sync.savedQty(sku) === undefined) this.sync.noteSaved(sku, Math.max(0, shownBefore));
    this.sync.set(sku, Math.max(0, qty));
  }

  /** The filters moved: write the address now, or once no save is outstanding. */
  writeUrl(href: string): void {
    if (this.holding) { this.owedUrl = href; return; }
    this.owedUrl = null;
    this.opts.replaceUrl(href);
  }

  /** Leave for another page now, or once no save is outstanding. True when it went now. */
  go(href: string): boolean {
    if (this.holding) {
      if (this.heldNav == null && this.sync.busy && this.active) this.opts.toast(CARD_SAVE_WAIT);
      this.heldNav = href;
      return false;
    }
    this.heldNav = null;
    this.opts.navigate(href);
    return true;
  }

  /**
   * The page mounted (true) or went away (false). Away, saves still go out
   * but nothing touches the screen, the address or the router: the address
   * by then belongs to another page.
   */
  setActive(active: boolean): void {
    this.active = active;
    if (active) return;
    this.owedUrl = null;
    this.heldNav = null;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  /** Send any save still waiting for its turn's timer now (unmount). */
  flush(): void {
    this.sync.flush();
  }

  private release(): void {
    this.releaseTimer = null;
    if (!this.active || this.sync.busy) return;
    const url = this.owedUrl;
    const nav = this.heldNav;
    this.owedUrl = null;
    this.heldNav = null;
    if (url != null) this.opts.replaceUrl(url);
    if (nav != null) this.opts.navigate(nav);
  }
}
