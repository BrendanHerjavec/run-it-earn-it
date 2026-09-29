import { after } from "next/server";
import type { PipelineDeps } from "./pipeline";
import { logEvent } from "./events";
import { runCheckoutLoop, runRewardAgent } from "./rewards";

/**
 * Production wiring. The agent runs after the response is sent (webhook ack,
 * Sync / Simulate buttons), so callers never wait on Claude. If the reward is
 * approved automatically (Sync countdown or auto-buy), the checkout loop
 * continues in the same background task. The app runs locally, so there's no
 * serverless time limit; the loop gives a browser checkout up to 20 minutes.
 */
export function pipelineDeps(opts: { autoApprove?: boolean } = {}): PipelineDeps {
  return {
    autoApprove: opts.autoApprove,
    onRewardCreated: async (db, rewardId) => {
      after(async () => {
        try {
          await runRewardAgent(db, rewardId);
          await runCheckoutLoop(db, rewardId);
        } catch (err) {
          await logEvent(db, { kind: "pipeline.error", rewardEventId: rewardId, message: String(err) });
        }
      });
    },
  };
}
