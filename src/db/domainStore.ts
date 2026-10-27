import type Database from "better-sqlite3";

export interface DomainStore {
  upsertCall(id: string, data: unknown, eventAt: string): void;
  upsertSummary(callId: string, data: unknown, eventAt: string): void;
  upsertMessage(id: string, data: unknown, eventAt: string): void;
  getCall(id: string): { data: unknown; eventAt: string } | null;
  getSummary(callId: string): { data: unknown; eventAt: string } | null;
  getMessage(id: string): { data: unknown; eventAt: string } | null;
}

// `table` is interpolated directly, not parameterized — safe only because it is always one
// of the three hardcoded string literals below, never external input. Do not reuse this
// helper with a table name from outside this file.
function makeUpsert(db: Database.Database, table: string, idColumn: string) {
  const stmt = db.prepare(
    `INSERT INTO ${table} (${idColumn}, data, event_at) VALUES (?, ?, ?)
     ON CONFLICT (${idColumn}) DO UPDATE SET data = excluded.data, event_at = excluded.event_at
     WHERE excluded.event_at >= ${table}.event_at`,
  );
  return (id: string, data: unknown, eventAt: string) => {
    stmt.run(id, JSON.stringify(data), eventAt);
  };
}

function makeGetter(db: Database.Database, table: string, idColumn: string) {
  const stmt = db.prepare(`SELECT data, event_at FROM ${table} WHERE ${idColumn} = ?`);
  return (id: string): { data: unknown; eventAt: string } | null => {
    const row = stmt.get(id) as { data: string; event_at: string } | undefined;
    if (!row) return null;
    return { data: JSON.parse(row.data) as unknown, eventAt: row.event_at };
  };
}

export function openDomainStore(db: Database.Database): DomainStore {
  return {
    upsertCall: makeUpsert(db, "calls", "id"),
    upsertSummary: makeUpsert(db, "summaries", "call_id"),
    upsertMessage: makeUpsert(db, "messages", "id"),
    getCall: makeGetter(db, "calls", "id"),
    getSummary: makeGetter(db, "summaries", "call_id"),
    getMessage: makeGetter(db, "messages", "id"),
  };
}
