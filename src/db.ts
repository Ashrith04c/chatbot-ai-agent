import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });
export const db = new Database(process.env.DB_PATH ?? "data/chat.db");
db.pragma("journal_mode = WAL");
db.exec(`
  create table if not exists turns (
    id        integer primary key autoincrement,
    user_id   text not null,
    chat_id   text not null,
    ts        text not null,          -- ISO 8601 UTC, when the question was asked
    question  text not null,
    answer    text not null,
    summary   text                    -- compact factual claims, used for "has it changed?" diffs
  );
  create index if not exists idx_turns_user_ts on turns(user_id, ts);
  create index if not exists idx_turns_chat on turns(chat_id, id);
`);

export type Turn = {
  id: number; user_id: string; chat_id: string; ts: string;
  question: string; answer: string; summary: string | null;
};

export function saveTurn(t: Omit<Turn, "id" | "summary"> & { summary?: string | null }): number {
  const r = db
    .prepare("insert into turns (user_id, chat_id, ts, question, answer, summary) values (?,?,?,?,?,?)")
    .run(t.user_id, t.chat_id, t.ts, t.question, t.answer, t.summary ?? null);
  return Number(r.lastInsertRowid);
}

export const setSummary = (id: number, summary: string) =>
  db.prepare("update turns set summary = ? where id = ?").run(summary, id);

export const chatTurns = (chatId: string, limit = 8): Turn[] =>
  (db.prepare("select * from turns where chat_id = ? order by id desc limit ?").all(chatId, limit) as Turn[]).reverse();

export const userTurnsSince = (userId: string, sinceIso: string): Turn[] =>
  db.prepare("select * from turns where user_id = ? and ts >= ? order by ts desc").all(userId, sinceIso) as Turn[];
