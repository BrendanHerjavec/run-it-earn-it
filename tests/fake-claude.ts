import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "@/lib/agent";

type Block = Anthropic.ContentBlock;
let n = 0;

export function toolUse(name: string, input: Record<string, unknown>): Block {
  return { type: "tool_use", id: `toolu_${++n}`, name, input } as Block;
}
export function text(t: string): Block {
  return { type: "text", text: t, citations: null } as Block;
}
export function thinking(t: string): Block {
  return { type: "thinking", thinking: t, signature: "sig" } as Block;
}

/**
 * A scripted stand-in for Claude. Each turn is a list of content blocks; a
 * turn with tool_use blocks gets stop_reason "tool_use", otherwise "end_turn".
 * Records every request so tests can inspect what the agent sent back.
 */
export function scriptedClaude(turns: Block[][]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const createMessage: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const content = turns[requests.length - 1] ?? [text("done")];
    return {
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    } as unknown as Anthropic.Message;
  };
  return { createMessage, requests };
}
