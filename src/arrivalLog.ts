export type ArrivalOutcome = "accepted" | "duplicate" | "faulted";
export type RejectionReason = "bad_signature" | "malformed_json";

const counters: Record<ArrivalOutcome | RejectionReason, number> = {
  accepted: 0,
  duplicate: 0,
  faulted: 0,
  bad_signature: 0,
  malformed_json: 0,
};

export function logArrival(args: {
  webhookId: string;
  eventType: string;
  outcome: ArrivalOutcome;
}): void {
  counters[args.outcome] += 1;
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

export function logRejection(args: { reason: RejectionReason }): void {
  counters[args.reason] += 1;
  console.warn(
    JSON.stringify({
      event: "rejected",
      reason: args.reason,
      ts: new Date().toISOString(),
    }),
  );
}

export function getArrivalCounters(): Record<ArrivalOutcome | RejectionReason, number> {
  return { ...counters };
}
