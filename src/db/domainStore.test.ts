import { describe, expect, it } from "vitest";
import { openDb } from "./openDb.js";
import { openDomainStore } from "./domainStore.js";

describe("domainStore", () => {
  it("allows a summary to arrive before its call and joins correctly", () => {
    const db = openDb(":memory:");
    const store = openDomainStore(db);

    store.upsertSummary("call_1", { text: "summary text" }, "2026-01-01T00:00:10.000Z");
    store.upsertCall("call_1", { status: "completed" }, "2026-01-01T00:00:05.000Z");

    const joined = db
      .prepare(
        `SELECT calls.id AS call_id, summaries.call_id AS summary_call_id
         FROM calls JOIN summaries ON calls.id = summaries.call_id
         WHERE calls.id = ?`,
      )
      .get("call_1") as { call_id: string; summary_call_id: string } | undefined;

    expect(joined).toBeDefined();
    expect(joined?.call_id).toBe("call_1");
    expect(joined?.summary_call_id).toBe("call_1");
  });

  it("does not let a stale event overwrite newer data", () => {
    const db = openDb(":memory:");
    const store = openDomainStore(db);

    store.upsertCall("call_2", { status: "completed", version: "new" }, "2026-01-01T00:10:00.000Z");
    store.upsertCall("call_2", { status: "ringing", version: "old" }, "2026-01-01T00:05:00.000Z");

    const row = store.getCall("call_2");
    expect(row?.eventAt).toBe("2026-01-01T00:10:00.000Z");
    expect((row?.data as { version: string }).version).toBe("new");
  });

  it("applies a newer event over older data", () => {
    const db = openDb(":memory:");
    const store = openDomainStore(db);

    store.upsertMessage("msg_1", { text: "first" }, "2026-01-01T00:00:00.000Z");
    store.upsertMessage("msg_1", { text: "second" }, "2026-01-01T00:00:01.000Z");

    const row = store.getMessage("msg_1");
    expect(row?.eventAt).toBe("2026-01-01T00:00:01.000Z");
    expect((row?.data as { text: string }).text).toBe("second");
  });
});
