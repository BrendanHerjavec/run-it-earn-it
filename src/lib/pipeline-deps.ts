import { after } from "next/server";
import type { PipelineDeps } from "./pipeline";
import { logEvent } from "./events";
import { runCheckoutLoop, runRewardAgent } from "./rewards";

/**
 * Production wiring. The agent runs after the response is sent (webhook ack,
 * simulate button), so callers never wait on Claude. If auto-buy approves the
 * reward, the checkout loop continues in the same background task.
 */
export function pipelineDeps(): PipelineDeps {
  return {
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
