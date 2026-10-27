import { describe, expect, it } from "vitest";
import { openDb } from "../db/openDb.js";
import { openDomainStore } from "../db/domainStore.js";
import { makeDispatchHandler } from "./index.js";

describe("dispatchHandler", () => {
  it("upserts a call using data.resource.completedAt as event_at", async () => {
    const domainStore = openDomainStore(openDb(":memory:"));
    const dispatch = makeDispatchHandler(domainStore);

    await dispatch("call.completed", {
      data: { resource: { id: "call_1", status: "completed", completedAt: "2026-01-01T00:00:05.000Z" } },
    });

    const row = domainStore.getCall("call_1");
    expect(row?.eventAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("upserts a message using data.resource.createdAt as event_at", async () => {
    const domainStore = openDomainStore(openDb(":memory:"));
    const dispatch = makeDispatchHandler(domainStore);

    await dispatch("message.received", {
      data: { resource: { id: "msg_1", text: "hi", createdAt: "2026-01-01T00:00:01.000Z" } },
    });

    const row = domainStore.getMessage("msg_1");
    expect(row?.eventAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("upserts a summary keyed by data.resource.callId, using the top-level createdAt as event_at (no resource-level timestamp exists)", async () => {
    const domainStore = openDomainStore(openDb(":memory:"));
    const dispatch = makeDispatchHandler(domainStore);

    await dispatch("call.summary.completed", {
      createdAt: "2026-01-01T00:00:10.000Z",
      data: {
        resource: {
          callId: "call_1",
          processingStatus: "completed",
          summary: ["no actionable details"],
        },
      },
    });

    const row = domainStore.getSummary("call_1");
    expect(row?.eventAt).toBe("2026-01-01T00:00:10.000Z");
    expect((row?.data as { processingStatus: string }).processingStatus).toBe("completed");
  });

  it("throws for an unrecognized event type", async () => {
    const domainStore = openDomainStore(openDb(":memory:"));
    const dispatch = makeDispatchHandler(domainStore);

    await expect(dispatch("unknown.event", { data: { resource: {} } })).rejects.toThrow();
  });
});
