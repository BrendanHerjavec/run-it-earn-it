import { after, NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { consumeApprovalToken, rewardPageUrl } from "./approval";
import { logEvent } from "./events";
import { approveReward, runCheckoutLoop, skipReward } from "./rewards";

/**
 * Shared handler for /api/rewards/:id/approve and /skip.
 *  POST = the ntfy button (or the confirm page below). Consumes the token.
 *  GET  = someone opened the link in a browser: show a confirm button instead
 *         of acting, so link previews and prefetchers can't approve a purchase.
 */
export function approvalHandlers(action: "approve" | "skip") {
  const verb = action === "approve" ? "Approve" : "Skip";

  async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const token = req.nextUrl.searchParams.get("token") ?? "";
    const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${verb} reward #${Number(id)}</title>
<body style="background:#0b0d10;color:#eef2f5;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" action="?token=${encodeURIComponent(token)}" style="text-align:center">
<p style="font-size:20px">${verb} reward #${Number(id)}?</p>
<button style="font-size:20px;padding:14px 28px;border-radius:12px;border:0;background:#c8f53a;font-weight:700">${verb}</button>
</form></body>`;
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    const token = req.nextUrl.searchParams.get("token") ?? "";
    const db = await getDb();
    const consumed = await consumeApprovalToken(db, id, token);
    if (consumed !== "ok") {
      await logEvent(db, { kind: `approval.${consumed}`, rewardEventId: id, message: `${action} link rejected (${consumed})` });
      const status = consumed === "invalid" ? 403 : 410;
      return NextResponse.json({ ok: false, error: consumed === "invalid" ? "Invalid link" : "Link expired or already used" }, { status });
    }

    if (action === "skip") {
      await skipReward(db, id, "notification");
      return NextResponse.json({ ok: true, skipped: true });
    }
    const result = await approveReward(db, id, "notification");
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    after(() => runCheckoutLoop(db, id));
    // Browsers (the confirm page) land on the live page; ntfy ignores the body.
    if (req.headers.get("accept")?.includes("text/html")) return NextResponse.redirect(rewardPageUrl(id), 303);
    return NextResponse.json({ ok: true });
  }

  return { GET, POST };
}
