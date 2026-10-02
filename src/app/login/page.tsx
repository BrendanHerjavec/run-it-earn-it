import { redirect } from "next/navigation";
import { authDisabled } from "@/lib/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  if (authDisabled()) redirect(next?.startsWith("/") ? next : "/");
  return (
    <main className="min-h-dvh grid place-items-center px-4">
      <form action="/api/auth/login" method="post" className="card w-full max-w-sm space-y-5">
        <div>
          <p className="eyebrow">Run It, Earn It</p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">Sign in</h1>
        </div>
        <input type="hidden" name="next" value={next ?? "/"} />
        <label className="block">
          <span className="label">Password</span>
          <input name="password" type="password" autoFocus required className="input mt-1" />
        </label>
        {error === "wrong" && <p className="text-sm text-bad">Wrong password.</p>}
        {error === "unset" && (
          <p className="text-sm text-bad">APP_PASSWORD is not set. Add it to .env.local and restart.</p>
        )}
        <button className="btn-primary w-full">Enter</button>
      </form>
    </main>
  );
}
