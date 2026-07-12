import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Local `npm run build` writes to .next-build so it can never corrupt the
  // .next directory a running dev server is serving from. Vercel/`next dev`
  // use the default.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.shopify.com" },
      { protocol: "https", hostname: "*.myshopify.com" },
      // Supabase Storage — custom-item photos snapped at the booth
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

// PWA: service worker + runtime caching. Disabled in dev (SW interferes with HMR).
const withPWA = withPWAInit({
  dest: "public",
  register: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    runtimeCaching: [
      {
        urlPattern: /^https:\/\/cdn\.shopify\.com\/.*/i,
        handler: "CacheFirst",
        options: { cacheName: "shopify-images", expiration: { maxEntries: 400, maxAgeSeconds: 7 * 24 * 60 * 60 } },
      },
      {
        urlPattern: /\/_next\/(image|static)\/.*/i,
        handler: "StaleWhileRevalidate",
        options: { cacheName: "next-assets" },
      },
    ],
  },
});

export default withPWA(nextConfig);
