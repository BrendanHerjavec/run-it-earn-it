import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

/** The app's Claude client. Uses ANTHROPIC_API_KEY from .env.local, plus a workspace header for org-level keys. */
export function anthropicClient(): Anthropic {
  const c = config();
  if (!c.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({
    apiKey: c.ANTHROPIC_API_KEY,
    timeout: 120_000,
    ...(c.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": c.ANTHROPIC_WORKSPACE_ID } } : {}),
  });
}
