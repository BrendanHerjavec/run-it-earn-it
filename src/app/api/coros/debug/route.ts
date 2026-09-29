import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { config } from "@/lib/config";
import { withCoros } from "@/lib/coros";
import { getUser } from "@/lib/settings";

/**
 * Dev helper (logged-in, demo tools only): GET → list COROS MCP tools;
 * GET ?tool=name&args={json} → call one. Used to inspect the real data shapes.
 */
export async function GET(req: NextRequest) {
  if (!config().DEMO_TOOLS_ENABLED) return NextResponse.json({ error: "disabled" }, { status: 404 });
  const db = await getDb();
  const user = await getUser(db);
  const tool = req.nextUrl.searchParams.get("tool");
  const args = JSON.parse(req.nextUrl.searchParams.get("args") ?? "{}");
  try {
    const out: unknown = await withCoros(db, user, async (c): Promise<unknown> =>
      tool ? c.callTool({ name: tool, arguments: args }) : c.listTools(),
    );
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
