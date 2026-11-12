
import "dotenv/config";
import express from "express";
import { runAgent } from "./agent";
import { safeTz } from "./time";

for (const k of ["GEMINI_API_KEY", "TAVILY_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`Missing ${k}. Check your .env file.`);
    process.exit(1);
  }
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

app.post("/api/chat", async (req, res) => {
  const { userId, chatId, message, tz } = req.body ?? {};

  if (
    ![userId, chatId, message].every(
      (v) => typeof v === "string" && v.length > 0
    ) ||
    message.length > 4000
  ) {
    return res.status(400).json({
      error: "userId, chatId, message required",
    });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  const emit = (e: unknown) =>
    !res.writableEnded &&
    res.write(`data: ${JSON.stringify(e)}\n\n`);

  await runAgent({
    userId,
    chatId,
    message,
    tz: safeTz(tz),
    emit,
    signal: ac.signal,
  });

  res.end();
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () =>
  console.log(`Chat agent on http://localhost:${port}`)
);
