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
//
// CACHE POLICY (reworked 13 Sep). Every page in this portal is behind a login
// and personalised — a buyer's prices, credit balance and orders; a staff
// member's whole admin surface. Two rules follow from that:
//
//   1. NO page document, RSC payload or API response is ever written to a
//      cache. Cache Storage is origin-scoped, survives sign-out and is never
//      purged by this app, and these devices are shared showroom tablets. A
//      cached navigation would also bypass middleware, so the Supabase session
//      would stop being refreshed on that request.
//   2. Only genuinely public, immutable bytes are cached: content-hashed build
//      output, optimised images, and product photography from Shopify's CDN
//      and the PUBLIC Supabase storage buckets.
//
// This departs from the letter of the brief ("network-first for pages and API
// routes") to honour its constraint ("never cache authenticated Supabase
// responses", "no stale authenticated data"). NetworkFirst caches every
// successful authenticated response, which is precisely the thing we must not
// do. NetworkOnly plus the /~offline fallback delivers the same offline shell
// without the exposure. Flagged to Ansh.
//
// Anything NOT listed below is deliberately left unmatched, so it never enters
// the service worker at all: same-origin /api/* (which includes the staff-only
// /api/drive-photo image proxy and every PDF), and the direct browser->Supabase
// PostgREST/Realtime traffic from JobsTicker.
const withPWA = withPWAInit({
  dest: "public",
  register: true,
  disable: process.env.NODE_ENV === "development",

  // The generated start-url route wrapped `opaqueredirect` responses into
  // synthetic 200s and stored them under the key "/". With "/" redirecting to
  // /login that cached a zero-byte document; the moment "/" becomes role-aware
  // it would cache one user's landing page device-wide. We do not need it.
  // dynamicStartUrl is the one that matters: it is what unshifts a NetworkFirst
  // route for "/" carrying the opaqueredirect->synthetic-200 plugin. Verified
  // in node_modules/@ducanh2912/next-pwa/dist/index.js:977. cacheStartUrl only
  // governs whether the start URL is added to the precache.
  cacheStartUrl: false,
  dynamicStartUrl: false,

  // Precached at build time and served by the handlerDidError hook that
  // next-pwa attaches to every route below.
  fallbacks: { document: "/~offline" },

  workboxOptions: {
    // Ship the takeover PASSIVELY. Staff are about to get a service worker for
    // the first time (middleware used to 307 /sw.js to /admin for them), and
    // they are the people sitting in 20-minute delivery-intake and stock-take
    // forms. skipWaiting + clientsClaim would swap the worker under an open
    // tab mid-deploy; waiting for the tab to close costs nothing, because no
    // cache here holds anything a user is waiting on.
    skipWaiting: false,
    clientsClaim: false,

    // Replaces (not extends) next-pwa's default exclude list, so the three
    // defaults are repeated here.
    exclude: [
      /\/_next\/static\/.*(?<!\.p)\.woff2/,
      /\.map$/,
      /^manifest.*\.js$/,
      // Keep the staff route surface out of the precache manifest: /sw.js is
      // now publicly fetchable, and the manifest would otherwise enumerate
      // every /admin/* page chunk by name to anonymous callers. They are still
      // cached at runtime by the _next/static rule on first visit.
      //
      // A predicate on asset.name, NOT a URL regex: exclude is evaluated
      // against the webpack asset name ("static/chunks/app/admin/..."), which
      // has no /_next/ prefix, so a URL-shaped regex silently matches nothing.
      ({ asset }) => asset.name.startsWith("static/chunks/app/admin/"),

      // Server-side build output must never reach a browser. next-pwa appends
      // its own server/ exclusion, but empirically it does not catch these
      // under this Next version — replacing the default exclude array left 51
      // /_next/server/* client-reference manifests and the build-manifest JSONs
      // in the precache, which the previous worker did not ship. Matched on the
      // asset name in both possible shapes.
      ({ asset }) => /(^|\/)server\//.test(asset.name),
      ({ asset }) => /(^|\/)((app-)?build-manifest|react-loadable-manifest)\.json$/.test(asset.name),
    ],

    // Belt and braces: the same exclusion applied to the emitted manifest, so
    // it holds regardless of the asset-name prefix webpack happens to use.
    // Runs before next-pwa's own transform, hence the prefix-agnostic regexes.
    manifestTransforms: [
      (entries) => ({
        manifest: entries.filter(
          (e) =>
            !/(^|\/)server\//.test(e.url) &&
            !/(^|\/)((app-)?build-manifest|react-loadable-manifest)\.json$/.test(e.url),
        ),
        warnings: [],
      }),
    ],

    runtimeCaching: [
      {
        // Navigations: always the network; on failure the fallback plugin
        // serves the precached /~offline document. /api/ is excluded so a PDF
        // opened in a new tab fails as a PDF rather than rendering HTML.
        urlPattern: ({ request, url, sameOrigin }) =>
          request.mode === "navigate" && sameOrigin && !url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
      },
      {
        // Content-hashed build output — immutable by construction.
        urlPattern: /\/_next\/static\/.*/i,
        handler: "CacheFirst",
        options: { cacheName: "next-static", expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 } },
      },
      {
        // next/image output. Unauthenticated: /_next/image is excluded from
        // the middleware matcher, and its cache key is the full query string.
        urlPattern: /\/_next\/image\?.*/i,
        handler: "CacheFirst",
        options: { cacheName: "next-image", expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 } },
      },
      {
        urlPattern: /^https:\/\/cdn\.shopify\.com\/.*/i,
        handler: "CacheFirst",
        options: { cacheName: "shopify-images", expiration: { maxEntries: 400, maxAgeSeconds: 7 * 24 * 60 * 60 } },
      },
      {
        // PUBLIC Supabase storage buckets only — product photography. Scoped
        // to /storage/v1/object/public/ so it can never match PostgREST, Auth
        // or Realtime on the same host, and buyer-cards is excluded because
        // visiting cards are PII that happen to live in a public bucket.
        urlPattern: ({ url }) =>
          /\.supabase\.co$/i.test(url.hostname) &&
          url.pathname.startsWith("/storage/v1/object/public/") &&
          !url.pathname.startsWith("/storage/v1/object/public/buyer-cards/"),
        handler: "CacheFirst",
        options: { cacheName: "product-photos", expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 } },
      },
    ],
  },
});

export default withPWA(nextConfig);
