import { describe, expect, it, vi } from "vitest";
import { findReconcileCandidates, runReconciler } from "./reconciler.js";
import type { DeliverySummary, QuoApiClient } from "./quoApiClient.js";

function delivery(overrides: Partial<DeliverySummary>): DeliverySummary {
  return {
    id: "msg_default",
    eventId: "evt_default",
    resourceId: null,
    eventType: "message.received",
    status: "failed",
    nextAttemptAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("findReconcileCandidates", () => {
  it("includes only failed deliveries missing locally with a non-null eventId", () => {
    const deliveries: DeliverySummary[] = [
      delivery({ id: "d1", eventId: "evt1", status: "failed" }), // candidate
      delivery({ id: "d2", eventId: "evt2", status: "success" }), // not failed
      delivery({ id: "d3", eventId: "evt3", status: "failed" }), // already have it locally
      delivery({ id: "d4", eventId: null, status: "failed" }), // test delivery, no eventId
      delivery({ id: "d5", eventId: "evt5", status: "pending" }), // not failed
    ];
    const local = new Set(["evt3"]);

    const result = findReconcileCandidates(deliveries, local);

    expect(result).toEqual([
      { deliveryId: "d1", eventId: "evt1", eventType: "message.received", quoStatus: "failed" },
    ]);
  });

  it("returns nothing when there are no failed/missing deliveries", () => {
    const deliveries: DeliverySummary[] = [delivery({ status: "success" })];
    expect(findReconcileCandidates(deliveries, new Set())).toEqual([]);
  });
});

describe("runReconciler", () => {
  function stubClient(deliveries: DeliverySummary[]): { client: QuoApiClient; retrySpy: ReturnType<typeof vi.fn> } {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    const client: QuoApiClient = {
      listDeliveries: vi.fn().mockResolvedValue(deliveries),
      getDeliveryDetail: vi.fn(),
      retryDelivery: retrySpy,
    };
    return { client, retrySpy };
  }

  it("dry run finds candidates but never calls retryDelivery", async () => {
    const { client, retrySpy } = stubClient([delivery({ id: "d1", eventId: "evt1", status: "failed" })]);

    const result = await runReconciler(client, "47119", new Set(), { apply: false, pacingMs: 0 });

    expect(result.candidates).toHaveLength(1);
    expect(result.retried).toHaveLength(0);
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("--apply calls retryDelivery exactly once per candidate", async () => {
    const { client, retrySpy } = stubClient([
      delivery({ id: "d1", eventId: "evt1", status: "failed" }),
      delivery({ id: "d2", eventId: "evt2", status: "failed" }),
    ]);

    const result = await runReconciler(client, "47119", new Set(), { apply: true, pacingMs: 0 });

    expect(result.retried).toHaveLength(2);
    expect(retrySpy).toHaveBeenCalledTimes(2);
    expect(retrySpy).toHaveBeenCalledWith("47119", "d1");
    expect(retrySpy).toHaveBeenCalledWith("47119", "d2");
  });
});
