import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/events";
import { handleWebhookEvent } from "@/lib/pipeline";
import { pipelineDeps } from "@/lib/pipeline-deps";

// The agent runs inside after(); give it room on Vercel.
export const maxDuration = 300;

/** Subscription validation: Strava GETs this once when the webhook is registered. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const expected = config().STRAVA_WEBHOOK_VERIFY_TOKEN;
  if (p.get("hub.mode") !== "subscribe" || !expected || p.get("hub.verify_token") !== expected) {
    return NextResponse.json({ error: "verification failed" }, { status: 403 });
  }
  return NextResponse.json({ "hub.challenge": p.get("hub.challenge") });
}

const eventSchema = z.object({
  object_type: z.enum(["activity", "athlete"]),
  object_id: z.number(),
  aspect_type: z.enum(["create", "update", "delete"]),
  updates: z.record(z.string(), z.string()).optional(),
  owner_id: z.number(),
  subscription_id: z.number(),
  event_time: z.number(),
});

/** Events: acknowledge immediately (Strava wants 200 within 2s), then process. */
export async function POST(req: NextRequest) {
  const parsed = eventSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 200 });
  const event = parsed.data;

  after(async () => {
    const db = await getDb();
    try {
      await logEvent(db, { kind: "strava.webhook", message: `${event.object_type}:${event.aspect_type} ${event.object_id}`, data: event });
      const outcome = await handleWebhookEvent(db, event, pipelineDeps());
      await logEvent(db, { kind: "pipeline.outcome", activityId: "activityId" in outcome ? outcome.activityId : null, message: `${outcome.status}: ${outcome.reason}` });
    } catch (err) {
      await logEvent(db, { kind: "pipeline.error", message: String(err), data: { event } });
    }
  });

  return NextResponse.json({ ok: true });
}
