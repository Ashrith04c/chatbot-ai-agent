import * as chrono from "chrono-node";

export function safeTz(tz: unknown): string {
  try {
    if (typeof tz === "string") { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; }
  } catch { /* fall through */ }
  return "UTC";
}

/** Minutes east of UTC for `tz` at `date`. */
export function tzOffsetMinutes(tz: string, date: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export const dayKey = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

export const humanDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone: tz }).format(d);

export const humanDateTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(d);

export type ResolvedDate = { phrase: string; day: string; label: string; future: boolean };

/**
 * Resolve relative/absolute date phrases ("Monday", "last Tuesday", "3 November", "yesterday")
 * against the user's real clock. Bare weekdays resolve to the most recent past one, because
 * people say "on Monday we shortlisted..." about the past.
 */
export function resolveDates(text: string, now: Date, tz: string): ResolvedDate[] {
  const out: ResolvedDate[] = [];
  const results = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(tz, now) }, { forwardDate: false });
  for (const r of results) {
    if (r.text.length < 3) continue;
    let d = r.start.date();
    const forward = /\b(next|tomorrow|coming|upcoming|this coming)\b/i.test(r.text);
    if (d > now && r.start.isCertain("weekday") && !forward) d = new Date(d.getTime() - 7 * 86400000);
    out.push({ phrase: r.text, day: dayKey(d, tz), label: humanDate(d, tz), future: d > now });
    // "last Tuesday" is ambiguous (most recent Tuesday vs. Tuesday of last week): check both.
    if (/\blast\s+(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(r.text) && now.getTime() - d.getTime() < 6 * 86400000) {
      const e = new Date(d.getTime() - 7 * 86400000);
      out.push({ phrase: r.text + " (alt reading)", day: dayKey(e, tz), label: humanDate(e, tz), future: false });
    }
  }
  return out;
}
