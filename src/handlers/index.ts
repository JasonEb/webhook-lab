import type { DomainStore } from "../db/domainStore.js";
import { EVENT_TIMESTAMP_FIELD } from "./eventTimestampField.js";

interface QuoEventPayload {
  createdAt: string;
  type: string;
  data: {
    resource: Record<string, unknown>;
  };
}

export function makeDispatchHandler(store: DomainStore) {
  return async function dispatchHandler(eventType: string, payload: unknown): Promise<void> {
    const body = payload as QuoEventPayload;
    const resource = body.data.resource;

    switch (eventType) {
      case "call.completed": {
        const eventAt = resource[EVENT_TIMESTAMP_FIELD["call.completed"] as string] as string;
        store.upsertCall(resource.id as string, resource, eventAt);
        return;
      }
      case "call.summary.completed": {
        // No resource-level timestamp exists for this event type (confirmed via a real
        // capture, 2026-10-27 — see eventTimestampField.ts). Falls back to the top-level
        // webhook createdAt as the least-wrong available signal, not the general D10 rule.
        store.upsertSummary(resource.callId as string, resource, body.createdAt);
        return;
      }
      case "message.received": {
        const eventAt = resource[EVENT_TIMESTAMP_FIELD["message.received"] as string] as string;
        store.upsertMessage(resource.id as string, resource, eventAt);
        return;
      }
      default:
        throw new Error(`No handler for event type: ${eventType}`);
    }
  };
}
