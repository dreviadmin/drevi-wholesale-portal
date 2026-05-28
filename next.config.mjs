import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.shopify.com" },
      { protocol: "https", hostname: "*.myshopify.com" },
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
