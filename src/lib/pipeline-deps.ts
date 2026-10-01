import { after } from "next/server";
import type { PipelineDeps } from "./pipeline";
import { logEvent } from "./events";
import { runCheckoutLoop, runRewardAgent } from "./rewards";

/**
 * One reward at a time: several milestones can unlock from one sync, but there
 * is one shopping browser, and a clear one-after-another sequence films better.
 */
const g = globalThis as unknown as { __runnyQueue?: { tail: Promise<unknown> } };
const queue = (g.__runnyQueue ??= { tail: Promise.resolve() });
function enqueue(task: () => Promise<void>): Promise<void> {
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
