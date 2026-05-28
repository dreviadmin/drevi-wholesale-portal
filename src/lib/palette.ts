// Royal Noir palette — exact values from the locked catalog prototype.
// Mirrors tailwind.config.ts tokens; used for the prototype's fine-grained
// inline styles (sub-11px sizes, letter-spacing) that are awkward in utilities.
export const palette = {
  black: "#1A1A1A",
  softBlack: "#2D2926",
  gold: "#C4A35A",
  goldDeep: "#A88848",
  ivory: "#FAF6F0",
  ivoryDeep: "#F2EBDC",
  champagne: "#E8D5B7",
  crimsonSoft: "#FBEDEE",
  crimsonText: "#8C2331",
  crimsonBorder: "#E8C7CC",
  soldBg: "#EFEAE0",
  soldBtn: "#E6E0D0",
  mutedGreige: "#998F7A",
  muted: "#888888",
  pageBg: "#F5F1E8",
} as const;

// Stylized gradient placeholders (per garment hue) from the prototype.
export const HUES: Record<string, [string, string]> = {
  sage: ["#9CAE93", "#6F8467"],
  teal: ["#2E5F5F", "#1A4040"],
  maroon: ["#6B2222", "#42110F"],
  noir: ["#2A2A2A", "#0E0E0E"],
  ivory: ["#EBDFC8", "#C8B690"],
  gold: ["#C4A35A", "#8B6F2E"],
  crimson: ["#8C2331", "#4F0E18"],
  champagne: ["#E0CFAA", "#B89F6E"],
  royal: ["#1E3A6D", "#0C1E40"],
  emerald: ["#2F6F4A", "#13402A"],
  dustyrose: ["#C49AA0", "#8A6168"],
  charcoal: ["#3C3236", "#1A1416"],
};

const HUE_KEYS = Object.keys(HUES);

// Deterministic hue for a SKU so the placeholder is stable and varied.
export function hueForSku(sku: string): string {
  let h = 0;
  for (let i = 0; i < sku.length; i++) h = (h * 31 + sku.charCodeAt(i)) >>> 0;
  return HUE_KEYS[h % HUE_KEYS.length];
}
