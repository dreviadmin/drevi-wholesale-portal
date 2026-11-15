import { fail, guarded, json, preflight } from "@/lib/appointments/web-http";
import { websiteAvailability } from "@/lib/appointments/website-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The website booking box: start times for a type, day by day.
// GET ?type=store&party=solo|group&place=store&from=YYYY-MM-DD&days=14
// Contract: docs/WEBSITE-BOOKING-API.md.

export function OPTIONS(req: Request) {
  return preflight(req);
}

export const GET = guarded(async (req: Request) => {
  const r = await websiteAvailability(new URL(req.url).searchParams);
  if (!r.ok) return fail(req, r.error, r.status, r.code);
  return json(req, r);
});
