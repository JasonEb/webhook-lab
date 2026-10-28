export interface DeliverySummary {
  id: string;
  eventId: string | null;
  resourceId: string | null;
  eventType: string;
  status: "success" | "pending" | "sending" | "failed";
  nextAttemptAt: string | null;
  createdAt: string;
}

export interface DeliveryAttempt {
  id: string;
  timestamp: string;
  status: "success" | "failed" | "sending" | "pending";
  responseStatusCode: number;
  responseBody: string;
  responseDurationMs: number;
  triggerType: "scheduled" | "manual";
  url: string;
}

export interface DeliveryDetail {
  id: string;
  eventId: string | null;
  resourceId: string | null;
  eventType: string;
  createdAt: string;
  requestBody: unknown;
  attempts: DeliveryAttempt[];
}

export interface QuoApiClient {
  listDeliveries(webhookId: string): Promise<DeliverySummary[]>;
  getDeliveryDetail(webhookId: string, deliveryId: string): Promise<DeliveryDetail>;
  retryDelivery(webhookId: string, deliveryId: string): Promise<void>;
}

const BASE_URL = "https://api.quo.com";
const API_VERSION = "2026-03-30";

export function createQuoApiClient(apiKey: string): QuoApiClient {
  async function quoFetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Quo-Api-Version": API_VERSION,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Quo API ${res.status} on ${path}: ${body}`);
    }
    return res;
  }

  return {
    async listDeliveries(webhookId: string): Promise<DeliverySummary[]> {
      const all: DeliverySummary[] = [];
      let after: string | undefined;
      // Test deliveries (eventId: null) are filtered out here — they're not reconcilable
      // (D2's dedupe key doesn't exist for them) and aren't subject to the real retry
      // machinery either (confirmed Phase 4 E2), so returning them would just create
      // confusing no-op candidates for callers.
      do {
        const qs = new URLSearchParams({ limit: "50" });
        if (after) qs.set("after", after);
        const res = await quoFetch(`/webhooks/${webhookId}/events?${qs.toString()}`);
        const body = (await res.json()) as { data: DeliverySummary[]; nextCursor: string | null };
        all.push(...body.data.filter((d) => d.eventId !== null));
        after = body.nextCursor ?? undefined;
      } while (after);
      return all;
    },

    async getDeliveryDetail(webhookId: string, deliveryId: string): Promise<DeliveryDetail> {
      const res = await quoFetch(`/webhooks/${webhookId}/events/${deliveryId}`);
      const body = (await res.json()) as { data: DeliveryDetail };
      return body.data;
    },

    async retryDelivery(webhookId: string, deliveryId: string): Promise<void> {
      await quoFetch(`/webhooks/${webhookId}/events/${deliveryId}/retry`, { method: "POST" });
    },
  };
}
