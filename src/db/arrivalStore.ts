import type Database from "better-sqlite3";

export interface ArrivalRow {
  webhookId: string;
  eventType: string;
  receivedAt: string;
  tsHeader: string;
  outcome: "accepted" | "duplicate" | "faulted";
  label: string | null;
}

export interface ArrivalStore {
  record(row: ArrivalRow): void;
  countForWebhookId(webhookId: string): number;
  listAll(filter?: { sinceIso?: string; label?: string }): ArrivalRow[];
}

export function openArrivalStore(db: Database.Database): ArrivalStore {
  const insertStmt = db.prepare(
    `INSERT INTO arrivals (webhook_id, event_type, received_at, ts_header, outcome, label)
     VALUES (@webhookId, @eventType, @receivedAt, @tsHeader, @outcome, @label)`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS count FROM arrivals WHERE webhook_id = ?`);

  return {
    record(row: ArrivalRow): void {
      insertStmt.run({ ...row, label: row.label ?? null });
    },
    countForWebhookId(webhookId: string): number {
      const row = countStmt.get(webhookId) as { count: number };
      return row.count;
    },
    listAll(filter?: { sinceIso?: string; label?: string }): ArrivalRow[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.sinceIso) {
        clauses.push("received_at >= ?");
        params.push(filter.sinceIso);
      }
      if (filter?.label) {
        clauses.push("label = ?");
        params.push(filter.label);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT webhook_id, event_type, received_at, ts_header, outcome, label
           FROM arrivals ${where} ORDER BY webhook_id, received_at`,
        )
        .all(...params) as Array<{
        webhook_id: string;
        event_type: string;
        received_at: string;
        ts_header: string;
        outcome: string;
        label: string | null;
      }>;
      return rows.map((r) => ({
        webhookId: r.webhook_id,
        eventType: r.event_type,
        receivedAt: r.received_at,
        tsHeader: r.ts_header,
        outcome: r.outcome as ArrivalRow["outcome"],
        label: r.label,
      }));
    },
  };
}
