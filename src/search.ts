const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: string }>();

export type SearchArgs = { query: string; since?: string; topic?: "general" | "news" };

const validDay = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s) <= new Date() ? s : undefined);

async function tavily(args: SearchArgs, signal?: AbortSignal): Promise<string> {
  const body: Record<string, unknown> = {
    query: String(args.query).slice(0, 380),
    topic: args.topic === "news" ? "news" : "general",
    search_depth: "basic",
    max_results: 5,
    include_answer: false,
  };
  const since = validDay(args.since);
  if (since) body.start_date = since;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const data: any = await res.json();
  const rows = (data.results ?? []) as any[];
  if (!rows.length) return "No results.";
  // Trim hard: title, url, date, ~350 chars. Tokens = latency.
  return rows
    .map((r, i) => `[${i + 1}] ${r.title} | ${r.published_date ?? "date unknown"} | ${r.url}\n${String(r.content ?? "").replace(/\s+/g, " ").slice(0, 350)}`)
    .join("\n");
}

export async function webSearch(args: SearchArgs, signal?: AbortSignal): Promise<{ text: string; ok: boolean }> {
  const key = JSON.stringify([String(args.query).toLowerCase(), args.since, args.topic]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { text: hit.value, ok: true };
  try {
    let text: string;
    try { text = await tavily(args, signal); }
    catch (e) { if (signal?.aborted) throw e; text = await tavily(args, signal); } // one retry
    cache.set(key, { at: Date.now(), value: text });
    return { text, ok: true };
  } catch (e) {
    return { text: `SEARCH FAILED (${(e as Error).message}). Treat this as "could not verify", not "no change".`, ok: false };
  }
}
