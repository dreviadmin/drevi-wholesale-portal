/**
 * Drevi's two phone lines, kept apart on purpose.
 *
 * WHOLESALE — the number on the approved WhatsApp templates and the one a
 * buyer is told to call (Ansh, 27 Sep: "the phone number for the wholesale
 * side of things shall actually be what's on the template"). Every
 * buyer-facing contact point in this portal reads it from here.
 *
 * The RETAIL store line (+91 88280 43555) lives on the Shopify theme, the
 * store footer and the GST registration; it is deliberately NOT exported from
 * here so nobody reaches for it by habit. src/lib/supplier.ts still prints it
 * as the registered supplier phone on tax documents — retail bills and
 * wholesale invoices share that block.
 */
export const WHOLESALE_PHONE = "+91 99300 86178";
/** Same number as wa.me / E.164-without-plus want it. */
export const WHOLESALE_PHONE_DIGITS = "919930086178";
