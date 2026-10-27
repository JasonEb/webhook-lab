export type InsertResult = "inserted" | "duplicate";

export interface DeliveryStore {
  insertIfNew(args: {
    webhookId: string;
    eventType: string;
    payload: string;
    receivedAt: string;
  }): InsertResult;
  countAll(): number;
}
