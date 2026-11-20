import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { isDatabaseCall, noteScheduledRun, runAppointmentSender } from "@/lib/appointments/sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Appointment WhatsApps (0110): confirmations, reminders, staff alerts and the
// daily list. Called every 5 minutes by the database (pg_cron, 0113) with the
// token from appointment_sender in X-Appointments-Sender, and every few hours
// by .github/workflows/sync-cron.yml with the cron secret (a backstop: GitHub
// runs its schedule far less often than it says). Sends nothing unless the
// owner has switched automatic messages on in Appointments › Settings; see
// src/lib/appointments/sender.ts for every check a message passes before it goes.

function cronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`), got = Buffer.from(req.headers.get("authorization") ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

async function handle(req: Request) {
  const via = cronSecret(req) ? "github" : (await isDatabaseCall(req.headers.get("x-appointments-sender"))) ? "database" : null;
  if (!via) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const res = await runAppointmentSender();
    await noteScheduledRun(via, res);
    return NextResponse.json({ ok: true, via, ...res });
  } catch (e) {
    console.error("[appointments-cron]", (e as Error).message);
    await noteScheduledRun(via, { error: (e as Error).message });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
