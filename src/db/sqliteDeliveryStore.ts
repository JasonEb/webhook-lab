import Database from "better-sqlite3";
import type { DeliveryStore, InsertResult } from "./DeliveryStore.js";

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
`;

export function openDeliveryStore(path: string): DeliveryStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO deliveries (webhook_id, event_type, payload, received_at)
     VALUES (@webhookId, @eventType, @payload, @receivedAt)
     ON CONFLICT (webhook_id) DO NOTHING`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS count FROM deliveries`);

  return {
    insertIfNew(args): InsertResult {
      const result = insertStmt.run(args);
      return result.changes > 0 ? "inserted" : "duplicate";
    },
    countAll(): number {
      const row = countStmt.get() as { count: number };
      return row.count;
    },
  };
}
