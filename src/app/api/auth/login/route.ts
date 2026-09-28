import { NextResponse } from "next/server";
import { checkPassword, createSessionToken, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (!(await checkPassword(password))) {
    const url = new URL("/login", req.url);
    url.searchParams.set("error", process.env.APP_PASSWORD ? "wrong" : "unset");
    url.searchParams.set("next", safeNext);
    return NextResponse.redirect(url, 303);
  }

  const { token, expires } = await createSessionToken();
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
  return res;
}
