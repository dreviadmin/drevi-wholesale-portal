import type { Config } from "tailwindcss";

// Royal Noir — locked design tokens. Source of truth: CLAUDE.md + catalog prototype.
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Core palette
        black: "#1A1A1A",
        "soft-black": "#2D2926",
        gold: "#C4A35A",
        "gold-deep": "#A88848",
        ivory: "#FAF6F0",
        "ivory-deep": "#F2EBDC",
        champagne: "#E8D5B7",
        // Stock-state accents
        "crimson-soft": "#FBEDEE",
        "crimson-text": "#8C2331",
        "crimson-border": "#E8C7CC",
        "amber-soft": "#FFF8E1",
        // Neutrals used in the prototype
        "sold-bg": "#EFEAE0",
        "sold-btn": "#E6E0D0",
        "muted-greige": "#998F7A",
        "muted-grey": "#888888",
        // Page chrome
        "page-bg": "#F5F1E8",
      },
      fontFamily: {
        display: ["var(--font-playfair)", "Georgia", "serif"],
        accent: ["var(--font-cormorant)", "Georgia", "serif"],
        body: ["var(--font-montserrat)", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        utility: "0.18em",
        wordmark: "0.35em",
      },
      aspectRatio: {
        card: "4 / 5",
      },
    },
  },
  plugins: [],
};
export default config;
