// Which `data.resource.*` field carries the event's own timestamp (D10 stale guard).
// Confirmed against real (non-test) captures, 2026-10-27 — see architecture.md section 2.
//
// `message.received`: `data.resource.createdAt`.
// `call.completed`: `data.resource.completedAt`.
// `call.summary.completed`: has NO resource-level timestamp at all. Real fields are
// answeredByUserId/callId/fromPhoneNumber/handledByAiAgent/nextSteps/processingStatus/summary
// — none of them a timestamp. This event type is handled separately in
// `handlers/index.ts`, falling back to the top-level webhook `createdAt` (otherwise avoided
// per D10, since it's webhook-generation time, not domain-event time) because there is no
// better signal available for this one event type specifically.
export const EVENT_TIMESTAMP_FIELD: Record<string, string> = {
  "message.received": "createdAt",
  "call.completed": "completedAt",
};
