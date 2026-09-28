import type { DB } from "@/db";
import { eventLog } from "@/db/schema";

const SECRET_KEYS = /(token|secret|password|authorization|api[-_]?key|cookie|card|cvc|cvv)/i;

/** Deep-copy `value`, replacing anything that looks like a secret with "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) && typeof v !== "object" ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogInput = {
  kind: string;
  message?: string;
  data?: unknown;
  rewardEventId?: number | null;
  activityId?: number | null;
};

/** Append to the audit log. Never throws: logging must not break the pipeline. */
export async function logEvent(db: DB, e: LogInput): Promise<void> {
  try {
    await db.insert(eventLog).values({
      kind: e.kind,
      message: e.message ?? "",
      data: e.data === undefined ? null : redact(e.data),
      rewardEventId: e.rewardEventId ?? null,
      activityId: e.activityId ?? null,
    });
  } catch (err) {
    console.error("[event-log] failed to write", e.kind, err);
  }
  if (process.env.NODE_ENV !== "test") console.log(`[${e.kind}] ${e.message ?? ""}`);
}
