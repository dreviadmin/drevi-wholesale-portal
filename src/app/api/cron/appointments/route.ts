import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { runAppointmentSender } from "@/lib/appointments/sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Appointment WhatsApps (0110): confirmations, reminders, staff alerts and the
// daily list. Called every 10 minutes by .github/workflows/sync-cron.yml with
// the cron secret. Sends nothing unless the owner has switched automatic
// messages on in Appointments › Settings; see src/lib/appointments/sender.ts
// for every check a message passes before it goes.

function authorized(req: Request): boolean {
  const want = Buffer.from(`Bearer ${getEnv("CRON_SECRET")}`), got = Buffer.from(req.headers.get("authorization") ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await runAppointmentSender()) });
  } catch (e) {
    console.error("[appointments-cron]", (e as Error).message);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
