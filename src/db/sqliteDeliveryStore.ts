import type Database from "better-sqlite3";
import type { ClaimedDelivery, DeliveryRow, DeliveryStore, InsertResult } from "./DeliveryStore.js";

export function openDeliveryStore(db: Database.Database): DeliveryStore {
  const insertStmt = db.prepare(
    `INSERT INTO deliveries (webhook_id, event_type, payload, received_at, next_run_at)
     VALUES (@webhookId, @eventType, @payload, @receivedAt, @receivedAt)
     ON CONFLICT (webhook_id) DO NOTHING`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS count FROM deliveries`);

  const claimSelectStmt = db.prepare(
    `SELECT webhook_id, event_type, payload, attempts FROM deliveries
     WHERE status = 'pending' AND next_run_at <= ?
       AND (locked_until IS NULL OR locked_until <= ?)
     ORDER BY next_run_at LIMIT 1`,
  );
  const claimUpdateStmt = db.prepare(
    `UPDATE deliveries SET locked_until = ?, attempts = attempts + 1 WHERE webhook_id = ?`,
  );
  const claimTxn = db.transaction((now: Date, leaseMs: number): ClaimedDelivery | null => {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const row = claimSelectStmt.get(nowIso, nowIso) as
      | { webhook_id: string; event_type: string; payload: string; attempts: number }
      | undefined;
    if (!row) return null;
    claimUpdateStmt.run(leaseUntil, row.webhook_id);
    return {
      webhookId: row.webhook_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts + 1,
    };
  });

  const markDoneStmt = db.prepare(`UPDATE deliveries SET status = 'done' WHERE webhook_id = ?`);
  const markDeadStmt = db.prepare(
    `UPDATE deliveries SET status = 'dead', last_error = ? WHERE webhook_id = ?`,
  );
  const markRetryStmt = db.prepare(
    `UPDATE deliveries SET status = 'pending', next_run_at = ?, locked_until = NULL, last_error = ?
     WHERE webhook_id = ?`,
  );

  const listRecentStmt = db.prepare(
    `SELECT webhook_id, event_type, status, attempts, received_at
     FROM deliveries ORDER BY received_at DESC LIMIT ?`,
  );
  const countsByStatusStmt = db.prepare(
    `SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status`,
  );

  return {
    insertIfNew(args): InsertResult {
      const result = insertStmt.run(args);
      return result.changes > 0 ? "inserted" : "duplicate";
    },
    countAll(): number {
      const row = countStmt.get() as { count: number };
      return row.count;
    },
    claim(now: Date, leaseMs: number): ClaimedDelivery | null {
      return claimTxn(now, leaseMs);
    },
    markDone(webhookId: string): void {
      markDoneStmt.run(webhookId);
    },
    markFailed(args): void {
      if (args.attempts >= args.maxAttempts) {
        markDeadStmt.run(args.error, args.webhookId);
      } else {
        const nextRunAt = new Date(args.now.getTime() + args.backoffMs).toISOString();
        markRetryStmt.run(nextRunAt, args.error, args.webhookId);
      }
    },
    listRecent(limit: number): DeliveryRow[] {
      const rows = listRecentStmt.all(limit) as Array<{
        webhook_id: string;
        event_type: string;
        status: string;
        attempts: number;
        received_at: string;
      }>;
      return rows.map((r) => ({
        webhookId: r.webhook_id,
        eventType: r.event_type,
        status: r.status,
        attempts: r.attempts,
        receivedAt: r.received_at,
      }));
    },
    countsByStatus(): Record<string, number> {
      const rows = countsByStatusStmt.all() as Array<{ status: string; count: number }>;
      return Object.fromEntries(rows.map((r) => [r.status, r.count]));
    },
  };
}
