import { NextResponse } from "next/server";
import { getStaff } from "@/lib/staff";
import { fetchImageByRef, downloadNameForRef } from "@/lib/design-image-store";
import { attachmentHeader, isInlineImageType } from "@/lib/attachment-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff-only proxy that streams an outfit photo from Drive (service-account
// authed) so the browser never needs Drive credentials. Loaded via a plain
// <img> tag, so the request carries the staff session cookie.
//
// `dl=1` is the only variation (20 Sep — "every image in the studio should be
// downloadable"): same gate, same bytes, but the response asks the browser to
// SAVE the file instead of painting it. Everything about the URL without the
// flag is unchanged, which matters because every <img> on the portal already
// points here.

export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });

  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (!id) return new NextResponse("Missing id", { status: 400 });
  const download = params.get("dl") === "1";
  const sizeRaw = Number(params.get("s"));
  const size = Number.isFinite(sizeRaw) && sizeRaw >= 100 && sizeRaw <= 2000 ? Math.floor(sizeRaw) : undefined;

  // A download is always the ORIGINAL file: `s` is what the card needed, and
  // an operator saving a photo wants the pixels the engine produced, not the
  // 150px tile they happened to tap. Dropping it here also means a URL copied
  // off an <img> and given &dl=1 still saves full resolution.
  // Handles Drive ids and the portal-storage "sb:" refs alike.
  const img = await fetchImageByRef(id, download ? undefined : size);
  if (!img) return new NextResponse("Not found", { status: 404 });

  // Only a raster IMAGE is served as itself. Every legitimate ref here is a
  // photo, but a Drive id without `s` falls back to the file's own stored MIME
  // type — so an HTML or SVG file the service account can read would render
  // from the portal origin with the viewer's staff session. Anything else goes
  // out as an opaque download instead: an <img> still decodes a mislabelled
  // photo, a navigation saves rather than renders. SVG counts as unsafe, it
  // can carry script. nosniff stops the browser second-guessing either way.
  const servable = isInlineImageType(img.contentType);

  const headers: Record<string, string> = {
    "Content-Type": servable ? img.contentType : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    // Opened directly in a tab, the response is its own document: sandboxed,
    // it has no origin and runs nothing, whatever the bytes turn out to be.
    "Content-Security-Policy": "sandbox",
    // no-store, not "private, max-age=3600" (13 Sep). These are private
    // vendor, visiting-card and note photos behind a staff session, and the
    // response carries no Vary: Cookie — so the browser's own disk cache had
    // no user dimension and would repaint them for the next person on a
    // shared showroom tablet, for an hour, with no request reaching us.
    // "private" only bars shared caches; it explicitly permits that one.
    // A download path is no reason to relax it: the file the operator saves is
    // theirs, the cached copy would be the next operator's.
    "Cache-Control": "private, no-store",
  };
  if (download || !servable) {
    // The name comes from the database, not the query string — see
    // downloadNameForRef. attachmentHeader sanitises it anyway: base_sku and
    // colour are operator-typed columns on their way into a header.
    headers["Content-Disposition"] = attachmentHeader((await downloadNameForRef(id)) ?? "drevi-photo", img.contentType);
  }

  return new NextResponse(img.body, { status: 200, headers });
}
