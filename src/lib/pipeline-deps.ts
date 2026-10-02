import { after } from "next/server";
import type { PipelineDeps } from "./pipeline";
import { logEvent } from "./events";
import { runCheckoutLoop, runRewardAgent } from "./rewards";
import { createBasketOrder, runBasketOrder } from "./basket";
import type { DB } from "@/db";

/**
 * One reward at a time: several milestones can unlock from one sync, but there
 * is one shopping browser, and a clear one-after-another sequence films better.
 */
const g = globalThis as unknown as { __runnyQueue?: { tail: Promise<unknown> } };
const queue = (g.__runnyQueue ??= { tail: Promise.resolve() });
export function enqueue(task: () => Promise<void>): Promise<void> {
  const next = queue.tail.then(task, task);
  queue.tail = next.catch(() => {});
  return next;
}

/**
 * Production wiring. Rewards are processed after the response is sent (Sync /
 * Simulate buttons, webhook), so callers never wait on Claude. If the reward is
 * approved automatically (Sync countdown or auto-buy), its checkout runs before
 * the next reward starts. The app runs locally, so there's no serverless time limit.
 */
export function pipelineDeps(opts: { autoApprove?: boolean } = {}): PipelineDeps {
  return {
    autoApprove: opts.autoApprove,
    onRewardCreated: async (db, rewardId) => {
      after(() =>
        enqueue(async () => {
          try {
            await runRewardAgent(db, rewardId);
            await runCheckoutLoop(db, rewardId);
          } catch (err) {
            await logEvent(db, { kind: "pipeline.error", rewardEventId: rewardId, message: String(err) });
          }
        }),
      );
    },
  };
}

/**
 * End-of-window basket orders found during a Sync. Queued behind any picks
 * from the same Sync, so a run from the window's last day lands in the basket
 * before it's ordered.
 */
export function queueBasketOrders(db: DB, due: { challengeId: number; startKey: string }[]) {
  for (const d of due) {
    after(() =>
      enqueue(async () => {
        try {
          const id = await createBasketOrder(db, d.challengeId, d.startKey);
          if (id) await runBasketOrder(db, id);
        } catch (err) {
          await logEvent(db, { kind: "pipeline.error", message: `basket order: ${String(err)}` });
        }
      }),
    );
  }
}

/** "Check out now": the order already exists; run its countdown and checkout in the queue. */
export function queueOrderRun(db: DB, orderId: number) {
  after(() =>
    enqueue(async () => {
      try {
        await runBasketOrder(db, orderId);
      } catch (err) {
        await logEvent(db, { kind: "pipeline.error", orderId, message: String(err) });
      }
    }),
  );
}
