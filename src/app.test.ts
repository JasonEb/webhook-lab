import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp, type CreateAppOptions } from "./app.js";
import { openDb } from "./db/openDb.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";
import { openArrivalStore } from "./db/arrivalStore.js";
import { buildSignedHeaders } from "./testSupport/sign.js";

const TEST_SECRET =
  "whsec_" + Buffer.from("test-secret-for-quo-webhook-lab-phase2").toString("base64");

function setup(overrides: Partial<CreateAppOptions> = {}) {
  const db = openDb(":memory:");
  const store = openDeliveryStore(db);
  const arrivalStore = openArrivalStore(db);
  const app = createApp({ store, arrivalStore, secret: TEST_SECRET, ...overrides });
  return { store, arrivalStore, app };
}

describe("POST /webhooks/quo", () => {
  it("accepts a new, validly signed delivery", async () => {
    const { store, app } = setup();
    const payload = JSON.stringify({ id: "msg_e2e1", type: "call.completed" });
    const headers = buildSignedHeaders(TEST_SECRET, "msg_e2e1", payload);

    const res = await request(app)
      .post("/webhooks/quo")
      .set(headers)
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(200);
    expect(store.countAll()).toBe(1);
  });

  it("returns 200 on a duplicate and stores exactly one row", async () => {
    const { store, app } = setup();
    const payload = JSON.stringify({ id: "msg_e2e2", type: "message.received" });
    const headers = buildSignedHeaders(TEST_SECRET, "msg_e2e2", payload);

    const first = await request(app)
      .post("/webhooks/quo")
      .set(headers)
      .set("Content-Type", "application/json")
      .send(payload);
    const second = await request(app)
      .post("/webhooks/quo")
      .set(headers)
      .set("Content-Type", "application/json")
      .send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.countAll()).toBe(1);
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    const { store, app } = setup();
    const payload = JSON.stringify({ id: "msg_e2e3", type: "call.completed" });

    const res = await request(app)
      .post("/webhooks/quo")
      .set({
        "webhook-id": "msg_e2e3",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,garbage",
      })
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(401);
    expect(store.countAll()).toBe(0);
  });

  it("returns 400 when a validly signed body is not valid JSON", async () => {
    const { store, app } = setup();
    const payload = "not valid json";
    const headers = buildSignedHeaders(TEST_SECRET, "msg_e2e4", payload);

    const res = await request(app)
      .post("/webhooks/quo")
      .set(headers)
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(400);
    expect(store.countAll()).toBe(0);
  });

  it("fail_first:2 faults the first two arrivals of an event and accepts the third", async () => {
    const { store, arrivalStore, app } = setup({ faultMode: { type: "fail_first", n: 2 } });
    const payload = JSON.stringify({ id: "msg_fault1", type: "call.completed" });

    const send = () =>
      request(app)
        .post("/webhooks/quo")
        .set(buildSignedHeaders(TEST_SECRET, "msg_fault1", payload))
        .set("Content-Type", "application/json")
        .send(payload);

    const first = await send();
    const second = await send();
    const third = await send();

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(third.status).toBe(200);
    expect(store.countAll()).toBe(1);

    const arrivals = arrivalStore.listAll();
    expect(arrivals.map((a) => a.outcome)).toEqual(["faulted", "faulted", "accepted"]);
  });

  it("slow:50 delays the response by at least 50ms and still returns 200", async () => {
    const { app } = setup({ faultMode: { type: "slow", ms: 50 } });
    const payload = JSON.stringify({ id: "msg_slow1", type: "call.completed" });
    const headers = buildSignedHeaders(TEST_SECRET, "msg_slow1", payload);

    const start = Date.now();
    const res = await request(app)
      .post("/webhooks/quo")
      .set(headers)
      .set("Content-Type", "application/json")
      .send(payload);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
