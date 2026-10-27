import { describe, expect, it } from "vitest";
import { openDb } from "./db/openDb.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";
import { openDomainStore } from "./db/domainStore.js";
import { makeDispatchHandler } from "./handlers/index.js";
import { runOnce, type Dispatch, type WorkerConfig } from "./worker.js";

function setup() {
  const db = openDb(":memory:");
  const store = openDeliveryStore(db);
  const domainStore = openDomainStore(db);
  return { store, domainStore };
}

function fixedConfig(now: Date, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    leaseMs: 30_000,
    maxAttempts: 5,
    now: () => now,
    random: () => 0,
    ...overrides,
  };
}

describe("worker", () => {
  it("processes a message.received delivery end to end", async () => {
    const { store, domainStore } = setup();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const payload = {
      id: "evt_1",
      type: "message.received",
      data: { resource: { id: "msg_1", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" } },
    };
    store.insertIfNew({
      webhookId: "evt_1",
      eventType: "message.received",
      payload: JSON.stringify(payload),
      receivedAt: t0.toISOString(),
    });

    const dispatch = makeDispatchHandler(domainStore);
    const result = await runOnce(store, dispatch, fixedConfig(t0));

    expect(result).toBe("processed");
    expect(store.countsByStatus()).toEqual({ done: 1 });
    const row = domainStore.getMessage("msg_1");
    expect(row?.eventAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("retries with backoff when the handler throws, then succeeds", async () => {
    const { store } = setup();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    store.insertIfNew({
      webhookId: "evt_2",
      eventType: "call.completed",
      payload: "{}",
      receivedAt: t0.toISOString(),
    });

    let calls = 0;
    const flaky: Dispatch = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    };

    const first = await runOnce(store, flaky, fixedConfig(t0));
    expect(first).toBe("processed");
    expect(store.countsByStatus()).toEqual({ pending: 1 });

    const [row] = store.listRecent(1);
    expect(row?.attempts).toBe(1);

    // Backoff for attempt 1: min(1000 * 2^0, 60000) + 0 jitter = 1000ms
    const t1 = new Date(t0.getTime() + 1000);
    const second = await runOnce(store, flaky, fixedConfig(t1));
    expect(second).toBe("processed");
    expect(store.countsByStatus()).toEqual({ done: 1 });
    expect(calls).toBe(2);
  });

  it("reaches dead after maxAttempts and stops being claimable", async () => {
    const { store } = setup();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    store.insertIfNew({
      webhookId: "evt_3",
      eventType: "call.completed",
      payload: "{}",
      receivedAt: t0.toISOString(),
    });

    const alwaysFails: Dispatch = async () => {
      throw new Error("poison");
    };

    const maxAttempts = 3;
    let clock = t0;
    for (let i = 0; i < maxAttempts; i++) {
      const result = await runOnce(store, alwaysFails, fixedConfig(clock, { maxAttempts }));
      expect(result).toBe("processed");
      // Advance well past any possible backoff so the next attempt is eligible.
      clock = new Date(clock.getTime() + 120_000);
    }

    expect(store.countsByStatus()).toEqual({ dead: 1 });

    const after = await runOnce(store, alwaysFails, fixedConfig(clock, { maxAttempts }));
    expect(after).toBe("empty");
  });

  it("reclaims a row whose lease expired (simulated crash) and counts it as another attempt", () => {
    const { store } = setup();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    store.insertIfNew({
      webhookId: "evt_4",
      eventType: "call.completed",
      payload: "{}",
      receivedAt: t0.toISOString(),
    });

    const leaseMs = 30_000;
    const firstClaim = store.claim(t0, leaseMs);
    expect(firstClaim).not.toBeNull();
    expect(firstClaim?.attempts).toBe(1);
    // Simulate a crash: never call markDone/markFailed.

    const beforeLeaseExpiry = store.claim(new Date(t0.getTime() + 1000), leaseMs);
    expect(beforeLeaseExpiry).toBeNull();

    const afterLeaseExpiry = store.claim(new Date(t0.getTime() + leaseMs + 1), leaseMs);
    expect(afterLeaseExpiry).not.toBeNull();
    expect(afterLeaseExpiry?.webhookId).toBe("evt_4");
    expect(afterLeaseExpiry?.attempts).toBe(2);
  });
});
