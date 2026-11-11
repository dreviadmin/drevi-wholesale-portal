import type { MetadataRoute } from "next";

// Golden rule 7: the portal is invisible to the public — robots.txt disallows
// all (alongside the noindex meta in layout.tsx). The middleware matcher skips
// /robots.txt so crawlers get this file, not a redirect to /login.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
