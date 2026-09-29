import type { DB } from "@/db";
import { config } from "./config";
import { logEvent } from "./events";

/**
 * ntfy.sh push notifications (https://docs.ntfy.sh/publish/). We publish JSON
 * to the server root with the topic in the body. `http` actions make the phone
 * send the request directly when a button is tapped.
 */
export type NtfyAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | { action: "http"; label: string; url: string; method?: string; headers?: Record<string, string>; body?: string; clear?: boolean };

export type NtfyMessage = {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
  actions?: NtfyAction[];
};

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests capture notifications instead of sending them. */
export function setNotifyFetch(f: Fetch) {
  fetchImpl = f;
}

export async function notify(db: DB, msg: NtfyMessage, ctx: { rewardEventId?: number } = {}): Promise<boolean> {
  const c = config();
  if (!c.NTFY_TOPIC) {
    await logEvent(db, { kind: "notify.skipped", rewardEventId: ctx.rewardEventId, message: `NTFY_TOPIC not set: "${msg.title}"`, data: msg });
    return false;
  }
  try {
    const res = await fetchImpl(c.NTFY_SERVER.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.NTFY_TOKEN ? { Authorization: `Bearer ${c.NTFY_TOKEN}` } : {}),
      },
      body: JSON.stringify({ topic: c.NTFY_TOPIC, ...msg }),
    });
    // Action URLs carry single-use approval tokens; keep them out of the log.
    const logged = { ...msg, actions: msg.actions?.map((a) => ({ ...a, url: a.url.replace(/token=[^&]+/, "token=[redacted]") })) };
    await logEvent(db, {
      kind: res.ok ? "notify.sent" : "notify.failed",
      rewardEventId: ctx.rewardEventId,
      message: `${res.status} "${msg.title}"`,
      data: logged,
    });
    return res.ok;
  } catch (err) {
    await logEvent(db, { kind: "notify.failed", rewardEventId: ctx.rewardEventId, message: String(err) });
    return false;
  }
}
