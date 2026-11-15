import { clientIp, fail, guarded, json, originOk, preflight } from "@/lib/appointments/web-http";
import { websiteBook } from "@/lib/appointments/website-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The website booking box: book one time. POST JSON from drevifashion.com
// (see docs/WEBSITE-BOOKING-API.md). Every limit and the booking itself run in
// one database function under a lock (appt_book_web, 0112), and capacity is
// checked by the same appt_book() as staff bookings.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export const POST = guarded(async (req: Request) => {
  if (!originOk(req)) return fail(req, "Not allowed.", 403, "forbidden");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(req, "Send JSON.", 415, "bad_request");
  const raw = await req.text();
  if (raw.length > 16000) return fail(req, "Too long.", 413, "bad_request");
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { return fail(req, "Please try again.", 400, "bad_request"); }
  const r = await websiteBook(body, clientIp(req));
  if (!r.ok) {
    const { status, code, error, day } = r as { status: number; code: string; error: string; day?: unknown };
    return fail(req, error, status, code, day !== undefined ? { day } : {});
  }
  return json(req, r);
});
