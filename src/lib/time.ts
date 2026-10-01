/** Timezone-aware day/week boundaries without a date library. Weeks start Monday. */

function partsIn(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday),
  };
}

/** Offset of `timeZone` from UTC at `date`, in ms (e.g. Toronto in summer = -4h). */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight on the given local calendar date. */
function localMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(new Date(guess), timeZone);
  // Second pass corrects for a DST change between the guess and the answer.
  t = guess - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = partsIn(date, timeZone);
  return localMidnight(p.y, p.m, p.d, timeZone);
}

export function startOfLocalWeek(date: Date, timeZone: string): Date {
  const p = partsIn(date, timeZone);
  const shifted = new Date(Date.UTC(p.y, p.m - 1, p.d - p.weekday));
  return localMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

/** Local calendar date key, e.g. "2026-09-27". */
export function localDateKey(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** UTC instant of local midnight at the start of a "YYYY-MM-DD" local date. */
export function localDateStart(dateKey: string, timeZone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return localMidnight(y, m, d, timeZone);
}

/** Calendar arithmetic on "YYYY-MM-DD" keys (no timezone involved). */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole calendar days from key a to key b. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
