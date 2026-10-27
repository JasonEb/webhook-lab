import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openDb } from "./db/openDb.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";
import { buildSignedHeaders } from "./testSupport/sign.js";

const TEST_SECRET =
  "whsec_" + Buffer.from("test-secret-for-quo-webhook-lab-phase2").toString("base64");

function setup() {
  const store = openDeliveryStore(openDb(":memory:"));
  const app = createApp(store, TEST_SECRET);
  return { store, app };
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
});
