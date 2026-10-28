import type { DeliverySummary, QuoApiClient } from "./quoApiClient.js";

export interface ReconcileCandidate {
  deliveryId: string;
  eventId: string;
  eventType: string;
  quoStatus: string;
}

export function findReconcileCandidates(
  quoDeliveries: DeliverySummary[],
  localWebhookIds: Set<string>,
): ReconcileCandidate[] {
  return quoDeliveries
    .filter((d) => d.eventId !== null && d.status === "failed" && !localWebhookIds.has(d.eventId))
    .map((d) => ({
      deliveryId: d.id,
      eventId: d.eventId as string,
      eventType: d.eventType,
      quoStatus: d.status,
    }));
}

export interface ReconcileResult {
  candidates: ReconcileCandidate[];
  retried: ReconcileCandidate[];
}

export async function runReconciler(
  client: QuoApiClient,
  webhookId: string,
  localWebhookIds: Set<string>,
  options: { apply: boolean; pacingMs: number },
): Promise<ReconcileResult> {
  const deliveries = await client.listDeliveries(webhookId);
  const candidates = findReconcileCandidates(deliveries, localWebhookIds);
  const retried: ReconcileCandidate[] = [];

  if (options.apply) {
    for (const candidate of candidates) {
      await client.retryDelivery(webhookId, candidate.deliveryId);
      retried.push(candidate);
      if (options.pacingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.pacingMs));
      }
    }
  }

  return { candidates, retried };
}
