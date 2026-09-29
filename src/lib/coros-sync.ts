import FitParser from "fit-file-parser";
import { eq, inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, users, type User } from "@/db/schema";
import { withCoros } from "./coros";
import { logEvent } from "./events";
import { encodePolyline, type LatLng } from "./geo";
import { processActivity, storeActivity, type Outcome, type PipelineDeps } from "./pipeline";
import { getUser } from "./settings";
import type { StravaActivity } from "./strava";

/** COROS sport codes we treat as runs, mapped to Strava-style sport types. */
const RUN_CODES: Record<number, string> = { 100: "Run", 101: "Run", 102: "TrailRun", 103: "Run" };

export type CorosRunRef = {
  labelId: string;
  sportType: number;
  startTs: number; // unix seconds
  endTs: number;
  /** From the list text; used if the FIT download fails. */
  distanceM?: number;
  durationS?: number;
  title?: string;
};

function durationToSeconds(s: string): number {
  const parts = s.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * querySportRecords returns formatted text, not JSON. Each record looks like:
 *   1. Outdoor Run — 2026-03-21
 *      Time Window: startTimestamp=1774117014 | endTimestamp=1774117544
 *      Duration: 8:50 | Distance: 786 m
 *      LabelId: 470000000000000001 | SportType: 100
 */
export function parseSportRecords(text: string): CorosRunRef[] {
  const body = text.replace(/\\n/g, "\n");
  const blocks = body.split(/\n(?=\d+\.\s)/);
  const out: CorosRunRef[] = [];
  for (const b of blocks) {
    const id = b.match(/LabelId:\s*(\d+)\s*\|\s*SportType:\s*(\d+)/);
    const ts = b.match(/startTimestamp=(\d+)\s*\|\s*endTimestamp=(\d+)/);
    if (!id || !ts) continue;
    const dist = b.match(/Distance:\s*([\d.]+)\s*(km|m)\b/);
    const dur = b.match(/Duration:\s*([\d:]+)/);
    const title = b.match(/^\d+\.\s*(.+?)\s+—/m)?.[1];
    out.push({
      labelId: id[1],
      sportType: Number(id[2]),
      startTs: Number(ts[1]),
      endTs: Number(ts[2]),
      distanceM: dist ? Number(dist[1]) * (dist[2] === "km" ? 1000 : 1) : undefined,
      durationS: dur ? durationToSeconds(dur[1]) : undefined,
      title,
    });
  }
  return out;
}

type ParsedFit = {
  sessions?: { sport?: string; start_time?: Date; total_distance?: number; total_timer_time?: number; avg_speed?: number; enhanced_avg_speed?: number }[];
  records?: { position_lat?: number; position_long?: number }[];
};

/** Keep at most `max` points, evenly spaced, always including the last one. */
function downsample(points: LatLng[], max = 600): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** A COROS FIT file as a Strava-shaped activity, so the rest of the pipeline doesn't care where it came from. */
export function fitToActivity(ref: CorosRunRef, fit: ParsedFit): StravaActivity {
  const s = fit.sessions?.[0] ?? {};
  const distance = s.total_distance ?? ref.distanceM ?? 0;
  const moving = Math.round(s.total_timer_time ?? ref.durationS ?? ref.endTs - ref.startTs);
  const route = downsample(
    (fit.records ?? [])
      .filter((r) => r.position_lat != null && r.position_long != null)
      .map((r) => [r.position_lat!, r.position_long!] as LatLng),
  );
  return {
    id: 0,
    name: ref.title ?? "COROS run",
    sport_type: RUN_CODES[ref.sportType] ?? `COROS:${ref.sportType}`,
    distance,
    moving_time: moving,
    elapsed_time: ref.endTs - ref.startTs,
    average_speed: s.enhanced_avg_speed ?? s.avg_speed ?? distance / Math.max(1, moving),
    start_date: (s.start_time ?? new Date(ref.startTs * 1000)).toISOString(),
    map: { summary_polyline: route.length > 1 ? encodePolyline(route) : null },
  };
}

export type CorosSource = {
  listRuns(user: User, since: Date): Promise<CorosRunRef[]>;
  fetchRun(user: User, ref: CorosRunRef): Promise<StravaActivity>;
};

const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** The real COROS MCP server. */
export function mcpSource(db: DB): CorosSource {
  return {
    async listRuns(user, since) {
      const result = await withCoros(db, user, (c) =>
        c.callTool({
          name: "querySportRecords",
          arguments: {
            // Dates are whole days; widen by a day each side for timezones and filter by timestamp after.
            startDate: yyyymmdd(new Date(since.getTime() - 86_400_000)),
            endDate: yyyymmdd(new Date(Date.now() + 86_400_000)),
            sportTypeCodes: Object.keys(RUN_CODES).map(Number),
            minDistanceKm: null,
            maxDistanceKm: null,
            minDurationMinutes: null,
            maxDurationMinutes: null,
            maxAveragePace: null,
            locationKeyword: null,
            limit: 20,
          },
        }),
      );
      return parseSportRecords(textOf(result));
    },
    async fetchRun(user, ref) {
      try {
        const result = await withCoros(db, user, (c) =>
          c.callTool({ name: "downloadActivityFitFiles", arguments: { labelId: ref.labelId, sportType: ref.sportType } }),
        );
        const res = (result as { content?: { type: string; resource?: { blob?: string } }[] }).content?.find((c) => c.type === "resource");
        if (!res?.resource?.blob) throw new Error(`No FIT file returned: ${textOf(result).slice(0, 200)}`);
        const parser = new FitParser({ force: true, speedUnit: "m/s", lengthUnit: "m", mode: "list" });
        const fit = (await parser.parseAsync(Buffer.from(res.resource.blob, "base64"))) as ParsedFit;
        return fitToActivity(ref, fit);
      } catch (err) {
        // FIT downloads are capped at 50/day. Fall back to the list summary (no GPS, so no quests).
        await logEvent(db, { kind: "coros.fit_failed", message: `${ref.labelId}: ${String(err)}` });
        return fitToActivity(ref, {});
      }
    },
  };
}

export type SyncResult = { checked: number; newRuns: number; outcomes: Outcome[]; baseline?: boolean };

/**
 * Pull new COROS runs and push each through the reward pipeline.
 * The first sync after connecting only records a baseline: runs from before
 * you connected never earn rewards.
 */
export async function syncCoros(db: DB, deps: PipelineDeps & { source?: CorosSource; now?: Date } = {}): Promise<SyncResult> {
  const user = await getUser(db);
  if (!user.corosTokensEnc) return { checked: 0, newRuns: 0, outcomes: [] };
  const now = deps.now ?? new Date();

  if (!user.corosLastSeenAt) {
    const baseline = user.corosConnectedAt ?? now;
    await db.update(users).set({ corosLastSeenAt: baseline }).where(eq(users.id, user.id));
    await logEvent(db, { kind: "coros.baseline", message: `Counting COROS runs that start after ${baseline.toISOString()}` });
    user.corosLastSeenAt = baseline;
  }

  const source = deps.source ?? mcpSource(db);
  const since = user.corosLastSeenAt;
  const refs = (await source.listRuns(user, since)).filter((r) => r.startTs * 1000 > since.getTime());

  // Skip runs we already stored (another poll got there first).
  const ids = refs.map((r) => `coros:${r.labelId}`);
  const known = ids.length
    ? new Set((await db.select({ id: activities.externalId }).from(activities).where(inArray(activities.externalId, ids))).map((r) => r.id))
    : new Set<string | null>();

  const outcomes: Outcome[] = [];
  let newest = since.getTime();
  for (const ref of refs.sort((a, b) => a.startTs - b.startTs)) {
    newest = Math.max(newest, ref.startTs * 1000);
    if (known.has(`coros:${ref.labelId}`)) continue;
    const run = await source.fetchRun(user, ref);
    const { activity, created } = await storeActivity(db, run, "coros", `coros:${ref.labelId}`);
    if (created) outcomes.push(await processActivity(db, activity, deps));
  }
  if (newest > since.getTime()) {
    await db.update(users).set({ corosLastSeenAt: new Date(newest) }).where(eq(users.id, user.id));
  }
  if (outcomes.length) {
    await logEvent(db, { kind: "coros.sync", message: `${outcomes.length} new run(s): ${outcomes.map((o) => o.status).join(", ")}` });
  }
  return { checked: refs.length, newRuns: outcomes.length, outcomes };
}
