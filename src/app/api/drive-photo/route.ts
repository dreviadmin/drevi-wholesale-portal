import { NextResponse } from "next/server";
import { getStaff } from "@/lib/staff";
import { fetchDriveImage } from "@/lib/drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff-only proxy that streams an outfit photo from Drive (service-account
// authed) so the browser never needs Drive credentials. Loaded via a plain
// <img> tag, so the request carries the staff session cookie.
export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new NextResponse("Missing id", { status: 400 });

  const img = await fetchDriveImage(id);
  if (!img) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(img.body, {
    status: 200,
    headers: {
      "Content-Type": img.contentType,
      // Private cache: fine to reuse within the tab session; never on a CDN.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
