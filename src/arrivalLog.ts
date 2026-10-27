export type ArrivalOutcome = "accepted" | "duplicate" | "faulted";

export function logArrival(args: {
  webhookId: string;
  eventType: string;
  outcome: ArrivalOutcome;
}): void {
  console.log(
    JSON.stringify({
      event: "arrival",
      webhook_id: args.webhookId,
      event_type: args.eventType,
      outcome: args.outcome,
      ts: new Date().toISOString(),
    }),
  );
}

export function logRejection(args: { reason: "bad_signature" | "malformed_json" }): void {
  console.warn(
    JSON.stringify({
      event: "rejected",
      reason: args.reason,
      ts: new Date().toISOString(),
    }),
  );
}
