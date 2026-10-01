"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { settings, users } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { parseDollarsToCents } from "@/lib/format";
import { closeBrowser, getBrowser } from "@/lib/browser/session";
import { deleteDemoData } from "@/lib/demo";
import { getSettingsRow, getUser } from "@/lib/settings";

export type FormState = { error?: string; ok?: boolean };

export async function saveLimits(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const provider = String(form.get("provider") ?? "");
  const db = await getDb();
  await getSettingsRow(db);
  await db
    .update(settings)
    .set({
      maxOrderCents: parseDollarsToCents(form.get("maxOrder")),
      maxDailyCents: parseDollarsToCents(form.get("maxDaily")),
      maxWeeklyCents: parseDollarsToCents(form.get("maxWeekly")),
      autoBuyMaxCents: parseDollarsToCents(form.get("autoBuyMax")),
      autoBuy: form.get("autoBuy") === "on",
      provider: provider === "mock" || provider === "cart" || provider === "browser" || provider === "crossmint" || provider === "rye" ? provider : null,
      crossmintBuyerProfileId: String(form.get("crossmintBuyerProfileId") ?? "").trim() || null,
    })
    .where(eq(settings.id, 1));
  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true };
}

const profileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.union([z.literal(""), z.string().trim().email()]),
  phone: z.string().trim().max(30),
  addressLine1: z.string().trim().max(200),
  addressLine2: z.string().trim().max(200),
  city: z.string().trim().max(100),
  province: z.string().trim().max(10),
  postalCode: z.string().trim().max(12),
  country: z.string().trim().length(2),
  timezone: z.string().trim().min(1),
});

export async function saveProfile(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const parsed = profileSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: parsed.data.timezone });
  } catch {
    return { error: "timezone: not a valid IANA timezone (e.g. America/Toronto)" };
  }
  const db = await getDb();
  const user = await getUser(db);
  await db
    .update(users)
    .set({ ...parsed.data, country: parsed.data.country.toUpperCase(), province: parsed.data.province.toUpperCase() })
    .where(eq(users.id, user.id));
  revalidatePath("/settings");
  return { ok: true };
}

export async function disconnectStrava() {
  await requireAuth();
  const db = await getDb();
  const user = await getUser(db);
  await db.update(users).set({ stravaAthleteId: null, stravaTokensEnc: null }).where(eq(users.id, user.id));
  revalidatePath("/settings");
}

export async function disconnectCoros() {
  await requireAuth();
  const db = await getDb();
  const user = await getUser(db);
  await db.update(users).set({ corosTokensEnc: null, corosConnectedAt: null }).where(eq(users.id, user.id));
  revalidatePath("/settings");
}

/** Open the agent's Chrome profile on a store page so you can sign in (and save your card and address there) once. */
export async function openShoppingBrowser(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const url = String(form.get("url") ?? "");
  if (!/^https?:\/\//i.test(url)) return { error: "Enter a full http(s) URL" };
  try {
    const browser = await getBrowser();
    await browser.callTool({ name: "browser_navigate", arguments: { url } });
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    return { error: `Couldn't open Chrome: ${String(err)}` };
  }
}

export async function closeShoppingBrowser() {
  await requireAuth();
  await closeBrowser();
  revalidatePath("/settings");
}

export async function deleteDemoRuns() {
  await requireAuth();
  await deleteDemoData(await getDb());
  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath("/goals");
}
