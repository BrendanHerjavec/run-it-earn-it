import { asc, desc } from "drizzle-orm";
import { getDb } from "@/db";
import { wishlistItems } from "@/db/schema";
import { AppShell, PageTitle, TierPill } from "@/components/AppShell";
import { formatCad } from "@/lib/format";
import { ItemForm } from "./ItemForm";
import { deleteItem } from "./actions";

export const dynamic = "force-dynamic";

export default async function WishlistPage() {
  const db = await getDb();
  const items = await db.select().from(wishlistItems).orderBy(desc(wishlistItems.active), asc(wishlistItems.expectedPriceCents));

  return (
    <AppShell>
      <PageTitle eyebrow="What Claude can buy you" title="Wishlist" />

      <section className="card mb-8">
        <h2 className="mb-4 text-lg font-semibold">Add an item</h2>
        <ItemForm />
        <p className="mt-3 text-sm text-muted">
          The agent can only ever pick from this list. Paste the exact product page; the notes go to the checkout agent verbatim.
        </p>
      </section>

      <div className="space-y-4">
        {items.map((item) => (
          <details key={item.id} className={`card group ${item.active ? "" : "opacity-50"}`}>
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <TierPill tier={item.tier} />
                <span className="truncate text-lg font-semibold">{item.title}</span>
                {!item.active && <span className="pill text-muted">inactive</span>}
                {item.productUrl.includes("example.com/replace-me") && (
                  <span className="pill border-warn/40 text-warn">placeholder URL</span>
                )}
              </div>
              <span className="text-xl font-bold tabular-nums">{formatCad(item.expectedPriceCents)}</span>
            </summary>
            <div className="mt-5 border-t border-line pt-5">
              <ItemForm item={item} />
              <form action={deleteItem} className="mt-3">
                <input type="hidden" name="id" value={item.id} />
                <button className="btn-danger">Delete</button>
              </form>
            </div>
          </details>
        ))}
        {items.length === 0 && <p className="text-muted">No items yet.</p>}
      </div>
    </AppShell>
  );
}
