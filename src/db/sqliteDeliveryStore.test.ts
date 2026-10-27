import { describe, expect, it } from "vitest";
import { openDb } from "./openDb.js";
import { openDeliveryStore } from "./sqliteDeliveryStore.js";

describe("sqliteDeliveryStore", () => {
  it("sets next_run_at on insert so the row is immediately claimable", () => {
    const db = openDb(":memory:");
    const store = openDeliveryStore(db);
    const receivedAt = "2026-01-01T00:00:00.000Z";

    store.insertIfNew({
      webhookId: "evt_x",
      eventType: "call.completed",
      payload: "{}",
      receivedAt,
    });

    const claimed = store.claim(new Date(receivedAt), 30_000);
    expect(claimed).not.toBeNull();
    expect(claimed?.webhookId).toBe("evt_x");
  });
});
