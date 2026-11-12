import { chatTurns, userTurnsSince, type Turn } from "./db";
import { dayKey, humanDateTime, resolveDates } from "./time";

const STOP = new Set("what with that this have from they will would there their about which when were been your does just into than then them some more also only over very like after before since still today again".split(" "));
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function fmt(t: Turn, tz: string, full: boolean): string {
  const when = humanDateTime(new Date(t.ts), tz);
  const body = full
    ? `Q: ${clip(t.question, 500)}\n  A (as given then): ${clip(t.answer, 1800)}`
    : `Q: ${clip(t.question, 160)}\n  Claims then: ${clip(t.summary ?? t.answer, 260)}`;
  return `- [${when}]\n  ${body}`;
}

/**
 * Memory is retrieved by CODE and injected into context - it is not a tool.
 * (The brief gives the agent one tool: web search.)
 * Three signals: dates named in the message, keyword overlap, and a short recency index.
 */
export function buildMemory(opts: { userId: string; chatId: string; message: string; now: Date; tz: string }) {
  const { userId, chatId, message, now, tz } = opts;
  const since = new Date(now.getTime() - 120 * 86400000).toISOString();
  const all = userTurnsSince(userId, since);
  const thisChat = new Set(chatTurns(chatId, 50).map((t) => t.id));
  const other = all.filter((t) => !thisChat.has(t.id));

  const dates = resolveDates(message, now, tz);
  const lines: string[] = [];
  const shown = new Set<number>();

  if (dates.length) {
    lines.push("Dates you named, resolved against the real clock:");
    for (const d of dates) {
      const hits = other.filter((t) => dayKey(new Date(t.ts), tz) === d.day);
      lines.push(`"${d.phrase}" = ${d.label}${d.future ? " (in the future)" : ""} -> ${hits.length ? `${hits.length} past exchange(s):` : "NO recorded conversation on that day."}`);
      for (const t of hits.slice(0, 4)) {
        lines.push(fmt(t, tz, true));
        shown.add(t.id);
      }
    }
  }

  const q = words(message);
  const related = other
    .filter((t) => !shown.has(t.id))
    .map((t) => ({ t, score: [...words(t.question + " " + (t.summary ?? ""))].filter((w) => q.has(w)).length }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (related.length) {
    lines.push("Possibly related earlier exchanges (keyword match, may be noise):");
    for (const { t } of related) { lines.push(fmt(t, tz, true)); shown.add(t.id); }
  }

  const recent = other.filter((t) => !shown.has(t.id)).slice(0, 6);
  if (recent.length) {
    lines.push("Recent exchanges from other chats (index):");
    for (const t of recent) lines.push(fmt(t, tz, false));
  }

  return { text: lines.join("\n"), dates };
}
