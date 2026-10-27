import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  locked_until TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status_next_run ON deliveries(status, next_run_at);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  event_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  call_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  event_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  event_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ts_header TEXT NOT NULL,
  outcome TEXT NOT NULL,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_arrivals_webhook_id_received ON arrivals(webhook_id, received_at);
`;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
