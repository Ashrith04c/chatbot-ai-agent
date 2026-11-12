
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { writeFileSync } from "node:fs";
import { runAgent } from "../src/agent";
import { saveTurn } from "../src/db";
import { resolveDates } from "../src/time";

const TZ = "Asia/Kolkata";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY. Check your .env file.");
}

const judge = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const JUDGE_MODEL =
  process.env.FAST_MODEL ?? "gemini-2.5-flash-lite";

const now = new Date();

const at = (phrase: string) => {
  const r = resolveDates(phrase, now, TZ)[0];

  if (!r?.day) {
    throw new Error(`Could not resolve date phrase: ${phrase}`);
  }

  return new Date(`${r.day}T10:00:00+05:30`).toISOString();
};

type Case = {
  name: string;
  prompt: string;
  rubric: string;
  seed?: {
    ts: string;
    q: string;
    a: string;
    summary: string;
  };
  maxSearches?: number;
  minSearches?: number;
};

type Score = {
  correct: number;
  honest: number;
  note: string;
};

const cases: Case[] = [
  {
    name: "greeting",
    prompt: "hey, how's it going?",
    rubric: "Short friendly reply. No searching.",
    maxSearches: 0,
  },
  {
    name: "timeless",
    prompt: "Explain JavaScript closures in 3 sentences.",
    rubric: "Correct, concise, no search.",
    maxSearches: 0,
  },
  {
    name: "crm-shortlist",
    prompt:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    seed: {
      ts: at("Monday"),
      q: "Shortlist 5 CRM tools for a 20-person sales team",
      a: "Shortlist: HubSpot Sales Hub Starter ($20/seat/mo), Pipedrive Advanced ($24.90/seat/mo), Zoho CRM Standard ($14/seat/mo), Freshsales Growth ($9/seat/mo), Salesforce Starter ($25/seat/mo).",
      summary:
        "Shortlisted HubSpot, Pipedrive, Zoho, Freshsales, Salesforce Starter with per-seat prices $9-$25/mo.",
    },
    rubric:
      "Uses the 5 tools from memory, resolves Monday correctly, searches each tool (parallel), reports per-tool changed/unchanged/could-not-verify with sources and dates. Does not invent changes.",
    minSearches: 5,
  },
  {
    name: "what-did-i-ask",
    prompt:
      "What did I ask you on 3 November? Is your answer still correct today?",
    seed: {
      ts: at("3 November"),
      q: "What is the cheapest managed Postgres for a hobby project?",
      a: "Neon free tier (0.5 GB) and Supabase free tier (500 MB) are cheapest; paid starts about $5-25/mo.",
      summary:
        "Neon free 0.5GB; Supabase free 500MB; paid from ~$5-25/mo.",
    },
    rubric:
      "Correctly recalls the Postgres question from memory, quotes the earlier claims, searches to re-verify, gives per-claim verdicts.",
    minSearches: 1,
  },
  {
    name: "postgres-last-tuesday",
    prompt:
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    seed: {
      ts: at("last Tuesday"),
      q: "Compare Postgres hosting: Neon, Supabase, Render",
      a: "Neon Launch $19/mo, Supabase Pro $25/mo, Render Postgres from $7/mo.",
      summary:
        "Neon Launch $19; Supabase Pro $25; Render from $7.",
    },
    rubric:
      "Recalls the earlier comparison, searches with a since filter and/or current pricing pages, separates changed/unchanged/unverified.",
    minSearches: 2,
  },
  {
    name: "no-such-chat",
    prompt: "What did I ask you on 14 July?",
    rubric:
      "Honestly says there is no record of that day. Does not fabricate a past question. At most one clarifying question.",
    maxSearches: 0,
  },
  {
    name: "stale-trap",
    prompt: "What's the latest stable Node.js version?",
    rubric:
      "Searches, gives a specific current version with a cited source and date.",
    minSearches: 1,
  },
  {
    name: "multi-entity",
    prompt:
      "Compare current pricing of Linear, Jira and Asana for a 15-person team.",
    rubric:
      "Parallel searches per product, concise comparison with sources, flags uncertainty.",
    minSearches: 3,
  },
  {
    name: "role-lookup",
    prompt: "Who is the CEO of Intel right now?",
    rubric:
      "Searches and answers with a cited, current answer.",
    minSearches: 1,
  },
];

async function score(
  c: Case,
  answer: string
): Promise<Score> {
  const r = await judge.models.generateContent({
    model: JUDGE_MODEL,
    contents: `Today: ${now.toISOString().slice(0, 10)}

Prompt: ${c.prompt}

Rubric: ${c.rubric}

Answer:
${answer}`,
    config: {
      systemInstruction:
        'You grade a chat agent. Reply ONLY JSON: {"correct":1-5,"honest":1-5,"note":"<15 words"}. "honest" penalises fabricated memory, invented facts, or claiming "no change" without evidence.',
      responseMimeType: "application/json",
      maxOutputTokens: 200,
    },
  });

  const t = r.text ?? "";

  try {
    const match = t.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("No JSON found in judge response");
    }

    const parsed = JSON.parse(match[0]);

    return {
      correct: Number(parsed.correct) || 0,
      honest: Number(parsed.honest) || 0,
      note: String(parsed.note ?? "No note"),
    };
  } catch {
    return {
      correct: 0,
      honest: 0,
      note: "judge parse error",
    };
  }
}

async function main() {
  const rows: string[] = [
    "| case | ms | first token ms | searches | budget ok | correct | honest | note |",
    "|---|---|---|---|---|---|---|---|",
  ];

  for (const c of cases) {
    console.log(`\nRunning evaluation: ${c.name}`);

    const userId = `eval-${Date.now()}-${c.name}`;

    if (c.seed) {
      saveTurn({
        user_id: userId,
        chat_id: "seed",
        ts: c.seed.ts,
        question: c.seed.q,
        answer: c.seed.a,
        summary: c.seed.summary,
      });
    }

    const r = await runAgent({
      userId,
      chatId: `eval-${c.name}-${Date.now()}`,
      message: c.prompt,
      tz: TZ,
      emit: () => {},
      now,
    });

    const s = await score(c, r.answer);

    const ok =
      (c.maxSearches === undefined ||
        r.searches <= c.maxSearches) &&
      (c.minSearches === undefined ||
        r.searches >= c.minSearches);

    const row = `| ${c.name} | ${r.ms} | ${
      r.firstTokenMs ?? "-"
    } | ${r.searches} | ${ok ? "yes" : "NO"} | ${
      s.correct
    } | ${s.honest} | ${s.note.replace(/\|/g, "/")} |`;

    rows.push(row);

    console.log(row);
  }

  writeFileSync(
    "evals/results.md",
    rows.join("\n") + "\n"
  );

  console.log("\nWrote evals/results.md");
}

main().catch((error) => {
  console.error("Evaluation failed:", error);
  process.exitCode = 1;
});
