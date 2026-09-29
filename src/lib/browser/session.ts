import path from "node:path";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config";

/** The part of an MCP client the checkout agent needs (so tests can fake it). */
export type BrowserMcp = Pick<Client, "listTools" | "callTool">;

type Holder = { client?: Client; connecting?: Promise<Client> };
const g = globalThis as unknown as { __runnyBrowser?: Holder };
const holder: Holder = (g.__runnyBrowser ??= {});

/**
 * One visible Chrome window, driven by Microsoft's Playwright MCP server, with a
 * persistent profile in SHOPPING_PROFILE_DIR. Sign in to your store in it once;
 * checkouts reuse that session and the card saved at the store.
 * A persistent profile can only be open in one browser at a time, so this is a singleton.
 */
export async function getBrowser(): Promise<Client> {
  if (holder.client) return holder.client;
  holder.connecting ??= (async () => {
    const root = process.cwd();
    const profile = path.resolve(root, config().SHOPPING_PROFILE_DIR);
    const outDir = path.resolve(root, ".data/pw-out");
    mkdirSync(profile, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(root, "node_modules/@playwright/mcp/cli.js"),
        "--browser", "chrome",
        "--user-data-dir", profile,
        "--output-dir", outDir,
        "--viewport-size", "1280,860",
        "--image-responses", "omit",
      ],
      stderr: "ignore",
    });
    const client = new Client({ name: "run-it-earn-it-checkout", version: "1.0.0" });
    transport.onclose = () => {
      holder.client = undefined;
      holder.connecting = undefined;
    };
    await client.connect(transport);
    holder.client = client;
    return client;
  })().catch((err) => {
    holder.connecting = undefined;
    throw err;
  });
  return holder.connecting;
}

export async function closeBrowser(): Promise<void> {
  const c = holder.client;
  holder.client = undefined;
  holder.connecting = undefined;
  if (c) {
    await c.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
    await c.close().catch(() => {});
  }
}

export function browserOpen(): boolean {
  return !!holder.client;
}

/** Join the text parts of an MCP tool result. */
export function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** "- Page URL: https://…" line from a Playwright MCP result. */
export function pageUrlFrom(text: string): string | null {
  return text.match(/Page URL:\s*(\S+)/)?.[1] ?? null;
}
