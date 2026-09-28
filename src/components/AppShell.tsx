import Link from "next/link";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/goals", label: "Goals" },
  { href: "/wishlist", label: "Wishlist" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="text-lg font-black tracking-tight">
            Run It, <span className="text-volt">Earn It</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-fg">
                {n.label}
              </Link>
            ))}
            <form action="/api/auth/logout" method="post">
              <button className="rounded-md px-3 py-1.5 text-muted hover:text-fg">Log out</button>
            </form>
          </nav>
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-8 ${wide ? "max-w-7xl" : "max-w-6xl"}`}>{children}</main>
    </div>
  );
}

export function PageTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function TierPill({ tier }: { tier: string }) {
  const color = tier === "large" ? "text-ember border-ember/40" : tier === "medium" ? "text-volt border-volt/40" : "text-muted";
  return <span className={`pill ${color}`}>{tier}</span>;
}
