import type { PipelineDeps } from "./pipeline";

/**
 * Production wiring for the pipeline. Phase 3 plugs the Claude agent into
 * onRewardCreated; until then a new reward waits in `pending_agent`.
 */
export function pipelineDeps(): PipelineDeps {
  return {};
}
