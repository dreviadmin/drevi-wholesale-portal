import type { Metadata, Viewport } from "next";
import { Playfair_Display, Cormorant_Garamond, Montserrat } from "next/font/google";
import { KeyboardInset } from "@/components/KeyboardInset";
import { InstallPrompt } from "@/components/InstallPrompt";
import "./globals.css";

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-playfair",
  display: "swap",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-cormorant",
  display: "swap",
});

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-montserrat",
  display: "swap",
});

// The portal is invisible to the public (CLAUDE.md golden rule 7).
export const metadata: Metadata = {
  title: "Drevi Wholesale Portal",
  description: "Login-gated wholesale catalog for approved Drevi Fashion buyers.",
  robots: { index: false, follow: false },
  manifest: "/manifest.json",
  // iOS ignores most of the manifest, so Add to Home Screen is driven from
  // here. Safari prefers apple-mobile-web-app-title over the manifest's
  // short_name for the home-screen label, so this has to say "Drevi" too.
  // statusBarStyle was "black-translucent", which pushes the web view under
  // the status bar — and nothing in this app pads for the safe area, so the
  // sticky ivory headers would have slid under the clock. "default" keeps the
  // bar where iOS draws it. No regression: nobody has this installed yet
  // (middleware was 307ing /manifest.json, so it has never been installable).
  appleWebApp: { capable: true, title: "Drevi", statusBarStyle: "default" },
  icons: {
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#1A1A1A",
  // Android: resize the layout viewport when the keyboard opens, so bottom
  // Save buttons stay reachable. iOS ignores this — KeyboardInset covers it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${playfair.variable} ${cormorant.variable} ${montserrat.variable}`}>
      <body className="font-body antialiased bg-page-bg text-black">
        <KeyboardInset />
        {children}
        <InstallPrompt />
      </body>
    </html>
  );
}
