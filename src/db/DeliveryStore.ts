export type InsertResult = "inserted" | "duplicate";

export interface ClaimedDelivery {
  webhookId: string;
  eventType: string;
  payload: string;
  attempts: number;
}

export interface DeliveryRow {
  webhookId: string;
  eventType: string;
  status: string;
  attempts: number;
  receivedAt: string;
}

export interface DeliveryStore {
  insertIfNew(args: {
    webhookId: string;
    eventType: string;
    payload: string;
    receivedAt: string;
  }): InsertResult;
  countAll(): number;
  claim(now: Date, leaseMs: number): ClaimedDelivery | null;
  markDone(webhookId: string): void;
  markFailed(args: {
    webhookId: string;
    now: Date;
    attempts: number;
    maxAttempts: number;
    backoffMs: number;
    error: string;
  }): void;
  listRecent(limit: number): DeliveryRow[];
  countsByStatus(): Record<string, number>;
}
