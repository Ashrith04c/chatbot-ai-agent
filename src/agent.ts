
import { GoogleGenAI } from "@google/genai";
import { chatTurns, saveTurn, setSummary } from "./db";
import { buildMemory } from "./memory";
import { webSearch, type SearchArgs } from "./search";
import { humanDateTime } from "./time";

const MODEL = process.env.MODEL ?? "gemini-3.5-flash";
const FAST_MODEL = process.env.FAST_MODEL ?? "gemini-3.5-flash-lite";
const MAX_TOOL_ROUNDS = 3;

if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY. Add it to your .env file.");
}

const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export type Ev =
  | { type: "text"; delta: string }
  | { type: "status"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const STATIC_SYSTEM = `You are a fast, honest chat assistant with one tool: web_search.

WHEN TO SEARCH
- Do NOT search for greetings, chit-chat, timeless explanations, maths, or code help.
- DO search for anything that can change: prices, plans, versions, releases, news, people in roles, latest, current, still, since, changed.
- If a question has several entities, call web_search once per entity in the same turn.
- Search first, then answer.

SEARCH CRAFT
- Short, specific queries.
- For "has X changed since DATE", search recent news and the vendor's current official pricing or changelog.
- Use official sources wherever possible.
- Never invent dates or search results.

TIME AND MEMORY
- The date block is the ground truth for today.
- MEMORY contains real past exchanges retrieved by code.
- Never claim to remember anything that is not in MEMORY or visible chat.
- If historical information is missing, say so.
- For "has it changed", compare historical information with current facts.

HONESTY
- Distinguish no change found from could not verify.
- Never invent prices, versions or dates.
- If sources conflict, explain the conflict.
- Cite sources inline as [name](url).

STYLE
- Lead with the answer.
- Use concise explanations and short bullets.
- Avoid unnecessary headings and filler.
- Match the user's language and register.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description:
          "Search the web for current information. Returns up to 5 results with title, date, URL and snippet. Call multiple times for multiple entities.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Short, specific search query.",
            },
            since: {
              type: "STRING",
              description:
                "Optional YYYY-MM-DD date. Only use for recent changes since a date.",
            },
            topic: {
              type: "STRING",
              enum: ["general", "news"],
              description: "Use news for recent events and announcements.",
            },
          },
          required: ["query"],
        },
      },
    ],
  },
];

export type RunResult = {
  answer: string;
  searches: number;
  ms: number;
  firstTokenMs: number | null;
};

export async function runAgent(opts: {
  userId: string;
  chatId: string;
  message: string;
  tz: string;
  emit: (e: Ev) => void;
  signal?: AbortSignal;
  now?: Date;
}): Promise<RunResult> {
  const { userId, chatId, message, tz, emit, signal } = opts;

  const now = opts.now ?? new Date();
  const t0 = Date.now();

  let firstTokenMs: number | null = null;
  let answer = "";
  let searches = 0;

  try {
    // 1. Retrieve memory and recent conversation history.

    const memory = buildMemory({
      userId,
      chatId,
      message,
      now,
      tz,
    });

    const history = chatTurns(chatId, 8);

    const dateBlock = `DATE BLOCK
Now: ${humanDateTime(now, tz)} (${tz}).
ISO date: ${now.toISOString().slice(0, 10)}.`;

    const memBlock = `MEMORY
${memory.text || "No past exchanges on record."}`;

    const system = `${STATIC_SYSTEM}

${dateBlock}

${memBlock}`;

    // Gemini uses "model" instead of Anthropic's "assistant" role.

    const contents: any[] = [];

    for (const t of history) {
      contents.push({
        role: "user",
        parts: [
          {
            text: `[${humanDateTime(new Date(t.ts), tz)}] ${t.question}`,
          },
        ],
      });

      contents.push({
        role: "model",
        parts: [{ text: t.answer }],
      });
    }

    contents.push({
      role: "user",
      parts: [{ text: message }],
    });

    // 2. Agent tool-calling loop.

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      if (signal?.aborted) {
        break;
      }

      const last = round === MAX_TOOL_ROUNDS;

      const stream = await client.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          systemInstruction: system,
          maxOutputTokens: 1800,
          tools: last ? undefined : TOOLS,
          ...(last
            ? {
                toolConfig: {
                  functionCallingConfig: {
                    mode: "NONE",
                  },
                },
              }
            : {}),
        },
      });

      let modelParts: any[] = [];

      // Stream text and collect tool calls.

      for await (const chunk of stream) {
        const delta = chunk.text ?? "";

        if (delta) {
          firstTokenMs ??= Date.now() - t0;
          answer += delta;

          emit({
            type: "text",
            delta,
          });
        }

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];

        modelParts.push(...parts);
      }

      const functionCalls = modelParts
        .filter((part) => part.functionCall)
        .map((part) => part.functionCall);

      // Save the model's response to Gemini conversation context.

      if (modelParts.length > 0) {
        contents.push({
          role: "model",
          parts: modelParts,
        });
      }

      if (!functionCalls.length) {
        break;
      }

      searches += functionCalls.length;

      emit({
        type: "status",
        text: functionCalls
          .map((call: any) => `Searching: ${call.args?.query ?? "the web"}`)
          .join(" | "),
      });

      // Execute multiple searches concurrently.

      const results = await Promise.all(
        functionCalls.map(async (call: any) => {
          const args = call.args as SearchArgs;

          try {
            const result = await webSearch(args, signal);

            return {
              name: call.name,
              response: {
                result: result.text,
                success: result.ok,
              },
            };
          } catch (error) {
            return {
              name: call.name,
              response: {
                result: (error as Error).message,
                success: false,
              },
            };
          }
        }),
      );

      // Send search results back to Gemini.

      contents.push({
        role: "user",
        parts: results.map((result) => ({
          functionResponse: {
            name: result.name,
            response: result.response,
          },
        })),
      });
    }

    // 3. Persist the answer.

    if (signal?.aborted) {
      return {
        answer,
        searches,
        ms: Date.now() - t0,
        firstTokenMs,
      };
    }

    const id = saveTurn({
      user_id: userId,
      chat_id: chatId,
      ts: now.toISOString(),
      question: message,
      answer,
    });

    emit({ type: "done" });

    // 4. Summarize important claims for future retrieval.

    await summarise(id, message, answer);

    return {
      answer,
      searches,
      ms: Date.now() - t0,
      firstTokenMs,
    };
  } catch (error) {
    if (signal?.aborted) {
      return {
        answer,
        searches,
        ms: Date.now() - t0,
        firstTokenMs,
      };
    }

    emit({
      type: "error",
      message: (error as Error).message,
    });

    return {
      answer,
      searches,
      ms: Date.now() - t0,
      firstTokenMs,
    };
  }
}

// Summarize important claims using Gemini's fast model.

async function summarise(id: number, q: string, a: string) {
  try {
    const response = await client.models.generateContent({
      model: FAST_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Compress the assistant answer into its key checkable claims (names, prices, versions, dates, verdicts). Maximum 60 words, no preamble.

Question: ${q}

Answer:
${a.slice(0, 4000)}`,
            },
          ],
        },
      ],
      config: {
        maxOutputTokens: 200,
      },
    });

    const summary = response.text?.trim() ?? "";

    if (summary) {
      setSummary(id, summary);
    }
  } catch {
    // Summary is an optimization.
    // The original answer is already stored.
  }
}
