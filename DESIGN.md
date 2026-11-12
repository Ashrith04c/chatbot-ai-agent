# Design

## How it works
```
POST /api/chat -> context builder (code) -> model <-> web_search (parallel, cached) -> SSE stream -> persist turn -> summarise claims
```
One agent loop, one tool. Node + Express + SSE, Anthropic SDK, Tavily search, SQLite.

## Key insight
The prompts are really about **time and memory**: "on Monday", "3 November", "since then". A plain search agent fails by guessing dates and inventing the past. So:
- **Memory is code, not a tool.** The brief allows one tool. `memory.ts` resolves dates in the message (chrono-node, user's timezone, bare weekdays resolve to the past), pulls matching past turns, adds keyword matches and a short recency index, and injects them. The model sees "NO recorded conversation on that day" explicitly, so it can't bluff.
- **Every turn stores a claims summary** (Haiku, after the answer is streamed, off the critical path). "Is it still correct?" becomes: old claims vs fresh search, per claim.
- **Dated search.** `since` + `topic` params; the prompt tells the model to also hit official pages undated, because a date filter hides evergreen pricing pages.

## Speed
Context building is local SQLite, zero network. Parallel tool calls (one search per entity), max 3 tool rounds then `tool_choice: none` forces an answer, 8s search timeout with one retry, 5-min result cache, results trimmed to ~350 chars each, prompt caching on the static system prompt and tool schema (volatile date/memory block sits after it), tokens streamed immediately, "Searching: ..." status events.

## Honesty
Failed or empty search is returned as "could not verify", never "no change". Prompt forces per-claim verdicts: changed / unchanged / could not verify.

## Considered and rejected
- **Memory tool**: breaks the one-tool brief and costs a model round-trip.
- **Vector DB / embeddings**: a user's history is tiny; date + keyword retrieval is exact where it matters (dates).
- **Planner/critic multi-agent**: doubles latency for little gain.
- **LangChain**: opaque; ~150 lines of loop is clearer.
- **Always searching / deep research by default**: slow; most chat turns don't need it.

## Evals
`npm run eval` seeds past turns and runs 9 cases (greeting, timeless, the 3 brief examples, nonexistent chat, stale trap, multi-entity, role lookup), recording latency, searches, and an LLM-judge score. Results: see `evals/results.md` (paste table here after running).

## Another week
- Claim-level diffing with structured claims (entity, attribute, value, source, date) instead of a text summary.
- Fetch-and-read the top official page when snippets are ambiguous.
- Router: small model for easy turns, big model for multi-entity research.
- Rerank/dedupe results; source-quality weighting (official > blog > aggregator).
- Larger eval set with human review; regression gate in CI.
- Per-user auth, memory decay, and a "forget this" control.
