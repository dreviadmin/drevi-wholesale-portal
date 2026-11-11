// The toast after a Studio batch turns a portal on or off for a selection
// (SH on / SH off). Like the other batch toasts it says how many designs it
// changed, and how many were already in that state, rather than a bare
// "Shopify disabled" that reads the same for 1 design as for 300.

const designs = (n: number) => `${n} design${n === 1 ? "" : "s"}`;

export function portalToggleToast(
  portal: "wholesale" | "shopify",
  enabled: boolean,
  changed: number,
  unchanged = 0,
): string {
  const name = portal === "shopify" ? "Shopify" : "Wholesale";
  const head = `${name} ${enabled ? "enabled" : "disabled"} on ${designs(changed)}`;
  return unchanged > 0 ? `${head} · ${unchanged} already ${enabled ? "on" : "off"}` : head;
}
