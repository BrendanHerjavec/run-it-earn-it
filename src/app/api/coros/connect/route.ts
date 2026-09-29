import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { beginAuthorization, COROS_STATE_COOKIE } from "@/lib/coros";
import { logEvent } from "@/lib/events";

export async function GET(req: Request) {
  const db = await getDb();
  try {
    const { url, cookie } = await beginAuthorization(db);
    const res = NextResponse.redirect(url);
    res.cookies.set(COROS_STATE_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/coros",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    await logEvent(db, { kind: "coros.connect_failed", message: String(err) });
    return NextResponse.redirect(new URL("/settings?coros=error", req.url));
  }
}
