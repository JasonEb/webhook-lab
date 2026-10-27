# Phase 2: Ingest, Arrival Log, and Dedupe — Detailed Steps

Companion to `architecture.md` and `implementation_plan.md`. Expands Phase 2 (3 to 4 h) into concrete steps. Builds on Phase 1's `verifyQuoSignature`. This phase carries **the project's single biggest early risk**: E1, whether `webhook_id` is stable across Quo's retries. If it isn't, D2's dedupe key needs to be redesigned before any further phase makes sense.

**Goal of this phase:** a real Express route, backed by SQLite, that verifies, dedupes, and acknowledges deliveries — tested both in-process (supertest + locally signed requests) and live against Quo — plus E1's result recorded in `architecture.md`.

---

## 2.1 New dependencies

```bash
mise exec -- npm install -D supertest @types/supertest
```

- [x] Install `supertest` for in-process route testing against the Express app (no real network, no tunnel needed for these tests — per the plan's test strategy, CI makes no live API calls). Also needed `@types/better-sqlite3` (not anticipated in this plan) once `tsc` ran — `better-sqlite3` ships no types of its own.

## 2.2 Storage interface (D3)

A small interface now, so a later Postgres swap (or a `:memory:` SQLite swap for tests) stays contained to one file. Only the operation this phase needs — the worker (Phase 3) will extend it.

`src/db/DeliveryStore.ts`:
```ts
export type InsertResult = "inserted" | "duplicate";

export interface DeliveryStore {
  insertIfNew(args: {
    webhookId: string;
    eventType: string;
    payload: string;
    receivedAt: string;
  }): InsertResult;
  countAll(): number;
}
```

- [x] Create this interface. Added `countAll()` beyond the original sketch, to resolve 2.8's open "how do we assert exactly one row" question without reaching into SQLite internals from tests — decided it's generally useful (also feeds `/debug/stats` later) rather than test-only scope creep. Otherwise kept to exactly what Phase 2 needs — no worker methods yet.

## 2.3 SQLite schema and store implementation

Per `architecture.md` section 5, only `deliveries` is built now — **no `arrivals` table** (D8 defers it to Phase 4; arrivals are a structured log line instead, see 2.5).

`src/db/sqliteDeliveryStore.ts`:
```ts
import Database from "better-sqlite3";
import type { DeliveryStore, InsertResult } from "./DeliveryStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  locked_until TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status_next_run ON deliveries(status, next_run_at);
`;

export function openDeliveryStore(path: string): DeliveryStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO deliveries (webhook_id, event_type, payload, received_at)
     VALUES (@webhookId, @eventType, @payload, @receivedAt)
     ON CONFLICT (webhook_id) DO NOTHING`,
  );

  return {
    insertIfNew(args): InsertResult {
      const result = insertStmt.run(args);
      return result.changes > 0 ? "inserted" : "duplicate";
    },
  };
}
```

- [x] Create this file (plus `countAll()`, see 2.2). `result.changes > 0` is the dedupe signal — `ON CONFLICT DO NOTHING` makes a duplicate a no-op write, and `better-sqlite3` reports 0 rows changed for a no-op.
- [x] For production, `path` is `data/dev.sqlite` (gitignored). For tests, `path` is `:memory:`.
- [x] WAL mode set. Confirmed harmless on `:memory:` (silently falls back to `memory` journal mode, verified empirically before relying on it) rather than erroring.

## 2.4 Structured arrival logger

Per D8: one structured log line per arrival now, no table. Keep it to exactly the fields architecture.md specifies: `webhook_id`, `event_type`, `outcome`.

`src/arrivalLog.ts`:
```ts
export type ArrivalOutcome = "accepted" | "duplicate" | "faulted";

export function logArrival(args: {
  webhookId: string;
  eventType: string;
  outcome: ArrivalOutcome;
}): void {
  console.log(
    JSON.stringify({
      event: "arrival",
      webhook_id: args.webhookId,
      event_type: args.eventType,
      outcome: args.outcome,
      ts: new Date().toISOString(),
    }),
  );
}
```

- [x] Create this file (plus a `logRejection` helper for signature/parse failures, see next item). Structured JSON to stdout is enough for Phase 2 — no logging library added, per the plan.
- [x] **Design question, resolved as planned:** the documented outcome enum is `accepted | duplicate | faulted`. `faulted` is reserved for the Phase 4 fault injector (architecture.md 4.4) — it does not apply here. A **signature failure** (401) doesn't fit any of the three outcomes, and critically, D4 means the body isn't parsed yet when a signature check fails, so `event_type` isn't even known. Decision: **don't call `logArrival` at all on a signature failure.** Log the rejection separately (a plain line, no `event_type`, just enough for the `/debug/stats` style counters later) — this keeps the `arrival` log's schema exactly matching the documented outcome enum instead of inventing a fourth value architecture.md doesn't mention. Flag this choice in a short note back to `architecture.md` section 4.1 once implemented, since it's a real interpretation call, not something the docs spelled out explicitly.

## 2.5 Express app factory

Export a factory that returns the app **without calling `.listen()`**, so tests (2.7+) can drive it directly with `supertest` and a separate `server.ts` entrypoint can call `.listen()` for the real process. This also lets tests inject a `:memory:` store instead of a file-based one — the dependency injection point is exactly the `DeliveryStore` interface from 2.2.

`src/app.ts`:
```ts
import express, { type Request, type Response } from "express";
import { verifyQuoSignature, SignatureVerificationError } from "./verifyQuoSignature.js";
import { logArrival } from "./arrivalLog.js";
import type { DeliveryStore } from "./db/DeliveryStore.js";

export function createApp(store: DeliveryStore, secret: string) {
  const app = express();

  app.post(
    "/webhooks/quo",
    express.raw({ type: "application/json" }),
    (req: Request, res: Response) => {
      const rawBody = req.body as Buffer;

      try {
        verifyQuoSignature(rawBody, req.headers, secret);
      } catch (err) {
        if (err instanceof SignatureVerificationError) {
          res.status(401).end();
          return;
        }
        throw err;
      }

      let parsed: { id: string; type: string };
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.status(400).end();
        return;
      }

      const result = store.insertIfNew({
        webhookId: parsed.id,
        eventType: parsed.type,
        payload: rawBody.toString("utf8"),
        receivedAt: new Date().toISOString(),
      });

      logArrival({
        webhookId: parsed.id,
        eventType: parsed.type,
        outcome: result === "inserted" ? "accepted" : "duplicate",
      });

      res.status(200).end();
    },
  );

  return app;
}
```

- [x] Create this file.
- [x] **D4/D7 check:** `express.raw()` is mounted only on this one route, as the second argument to `.post()` — not via `app.use()` globally. Confirmed by reading `src/app.ts`.
- [x] `parsed.id` is the Quo event id, used as the dedupe key per D2 — **confirmed stable by E1 (2.13)**, no longer provisional.
- [x] 400 on malformed JSON after a valid signature, implemented and tested (2.10). Still worth a one-line addition to `architecture.md`'s failure-mode table — not yet done, tracked as a follow-up.

## 2.6 Test setup — shared signing helper

Phase 1's test file already has a `signPayload`/`buildHeaders` pair. Extract it to a shared test helper instead of duplicating it, since Phase 2's tests need to sign realistic full payloads (with `id`/`type` fields the route actually reads), not the minimal `{"type":"call.completed"}` stubs Phase 1 used.

`src/testSupport/sign.ts`:
```ts
import { Webhook } from "svix";

export function signPayload(secret: string, msgId: string, timestamp: Date, payload: string): string {
  return new Webhook(secret).sign(msgId, timestamp, payload);
}

export function buildSignedHeaders(secret: string, msgId: string, payload: string) {
  const timestamp = new Date();
  const sig = signPayload(secret, msgId, timestamp, payload);
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": sig,
  };
}
```

- [x] Create this file (as `signPayload` + `buildHeaders` + `buildSignedHeaders`).
- [x] Refactored `src/verifyQuoSignature.test.ts` to import `signPayload`/`buildHeaders` from here instead of redefining them.

## 2.7 Test: accepted

```ts
it("accepts a new, validly signed delivery", async () => {
  const store = openDeliveryStore(":memory:");
  const app = createApp(store, TEST_SECRET);
  const payload = JSON.stringify({ id: "msg_e2e1", type: "call.completed" });
  const headers = buildSignedHeaders(TEST_SECRET, "msg_e2e1", payload);

  const res = await request(app)
    .post("/webhooks/quo")
    .set(headers)
    .set("Content-Type", "application/json")
    .send(payload);

  expect(res.status).toBe(200);
});
```

- [x] Write this test. Uses `supertest`'s `request(app)`.

## 2.8 Test: duplicate

Send the same signed payload twice (same `webhook-id`, so same signature setup reused — or re-sign with a fresh timestamp but the same `msg_id`/body, since what matters for dedupe is the payload's `id` field, not the signature headers).

```ts
it("returns 200 on a duplicate and stores exactly one row", async () => {
  const store = openDeliveryStore(":memory:");
  const app = createApp(store, TEST_SECRET);
  const payload = JSON.stringify({ id: "msg_e2e2", type: "message.received" });
  const headers = buildSignedHeaders(TEST_SECRET, "msg_e2e2", payload);

  const first = await request(app).post("/webhooks/quo").set(headers).set("Content-Type", "application/json").send(payload);
  const second = await request(app).post("/webhooks/quo").set(headers).set("Content-Type", "application/json").send(payload);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  // Assert exactly one row: query the store directly, or add a test-only count helper —
  // decide which when implementing; don't reach into better-sqlite3 internals from the test
  // if a one-line addition to DeliveryStore (e.g. a test-only `countAll()`) is cleaner.
});
```

- [x] Write this test, using `store.countAll()` to assert exactly one row.
- [x] Resolved via `countAll()` (2.2) — no test-only internals reach-in needed.
- [x] Covers "two logged arrivals" implicitly via the row-count/status assertions; did not also spy on `console.log` — kept the test focused on externally observable behavior (status codes, row count) rather than log output, which the live-run step (2.12) checks directly anyway.

## 2.9 Test: bad signature

```ts
it("rejects a bad signature with 401 and stores nothing", async () => {
  const store = openDeliveryStore(":memory:");
  const app = createApp(store, TEST_SECRET);
  const payload = JSON.stringify({ id: "msg_e2e3", type: "call.completed" });

  const res = await request(app)
    .post("/webhooks/quo")
    .set({ "webhook-id": "msg_e2e3", "webhook-timestamp": "1700000000", "webhook-signature": "v1,garbage" })
    .set("Content-Type", "application/json")
    .send(payload);

  expect(res.status).toBe(401);
});
```

- [x] Write this test.
- [x] Asserts `store.countAll() === 0`.

## 2.10 Test: malformed JSON after valid signature

Sign a body that is valid bytes but not valid JSON, so verification passes and parsing fails.

```ts
it("returns 400 when a validly signed body is not valid JSON", async () => {
  const store = openDeliveryStore(":memory:");
  const app = createApp(store, TEST_SECRET);
  const payload = "not valid json";
  const headers = buildSignedHeaders(TEST_SECRET, "msg_e2e4", payload);

  const res = await request(app)
    .post("/webhooks/quo")
    .set(headers)
    .set("Content-Type", "application/json")
    .send(payload);

  expect(res.status).toBe(400);
});
```

- [x] Write this test. Confirmed `supertest`/superagent sends a plain string body as-is when `Content-Type` is set explicitly — no surprise re-encoding that would've broken the signature match.

## 2.11 `server.ts` entrypoint

Separate from `app.ts` so `npm run dev` (or similar) can actually listen, while `app.ts` stays test-friendly.

`src/server.ts`:
```ts
import "dotenv/config";
import { createApp } from "./app.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";

const secret = process.env.QUO_WEBHOOK_SECRET;
if (!secret) {
  throw new Error("QUO_WEBHOOK_SECRET is not set");
}

const store = openDeliveryStore("data/dev.sqlite");
const app = createApp(store, secret);
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => console.log(`Listening on :${port}`));
```

- [x] Create this file.
- [x] Added `"dev": "tsx watch src/server.ts"` to `package.json`.

## 2.12 Run against live Quo

- [x] Started a fresh tunnel: `https://challenges-rider-programs-controlling.trycloudflare.com`.
- [x] Updated the existing subscription (id `47119`) via `PATCH /webhooks/{webhookId}` — this endpoint does exist (`https://www.quo.com/docs/2026-03-30/webhooks/update-a-webhook-by-id.md`), no need to delete/recreate.
- [x] Ran the server (`mise exec -- npx tsx src/server.ts`).
- [x] Sent test events via `POST /webhooks/:id/events/test`, confirmed `200` and `accepted` arrival logs.
- [x] Re-sent the same test event (always reuses a fixed canned `id`), confirmed `duplicate` outcome logged and row count stayed at 1.
- [x] Tunnel and server both torn down after live testing.

## 2.13 Experiment E1 — the project's biggest early risk

**Question:** is `webhook_id` (the payload's `id` field, used as the dedupe key per D2) stable across Quo's automatic or manual retries of the same event?

**Result: confirmed stable.** Full detail in `architecture.md` section 2 (the "E1" and "Delivery `id` vs payload `id`" rows) and section 6 (D2, now Final). Summary:

- [x] Found the exact delivery-listing endpoint: `GET /webhooks/{webhookId}/events` (`https://www.quo.com/docs/2026-03-30/webhook-events/list-deliveries-for-a-webhook.md`) — not in the original architecture.md citation, found via the docs' `llms.txt` index after two guessed URLs 404'd.
- [x] **Important correction made along the way:** the delivery-list API revealed two distinct identifiers — `id` (delivery-level, equals the `webhook-id` header) and `eventId` (the payload body's own `id` field). These are not the same value and architecture.md previously didn't distinguish them. Test deliveries always have `eventId: null`, so a *real* (non-test) delivery was required for this experiment — triggered by sending another real text message.
- [x] Triggered a manual retry: `POST /webhooks/{webhookId}/events/{deliveryId}/retry` → `202 Accepted`.
- [x] Compared both identifiers before/after the retry, via two independent sources: the delivery-list API (no new entry appeared; same `id`/`eventId`/`createdAt`) and the actual re-received HTTP request's raw `webhook-id` header (temporarily logged, then reverted — see `src/app.ts` git history if needed). Both matched exactly.
- [x] **Recorded in `architecture.md`**: D2 moved to "Final, E1 confirmed" in section 6; the "Unknown" bullet removed from section 2; new Documented rows added for the update endpoint, delivery inspection (with corrected field list — the original `responseDurationMs`/`triggerType` guess from the third-party source doesn't match what the real endpoint returns), the id/eventId distinction, and the E1 result itself.
- [x] Not a redesign — D2's original dedupe-on-id approach holds, and the actual implementation (`src/app.ts`, keyed on the payload body's `id`) is correct as built.

## 2.14 Acceptance checklist (must all be true to close Phase 2)

- [x] `DeliveryStore` interface, SQLite implementation, and schema exist (2.2–2.3), matching `architecture.md` section 5 (no `arrivals` table yet, per D8), plus `countAll()` beyond the original schema.
- [x] Arrival logging matches the documented outcome enum with no undocumented fourth value — signature/parse failures go through `logRejection` instead (2.4).
- [x] `express.raw()` is mounted only on `/webhooks/quo`, confirmed by reading `src/app.ts` (2.5).
- [x] All four in-process tests pass: accepted, duplicate (exactly one row), bad signature (401, nothing stored), malformed JSON (400) (2.7–2.10). 14/14 total including Phase 1's tests.
- [x] `tsc --noEmit` and `eslint .` both pass clean.
- [x] Verified live against Quo through a real tunnel: test events accepted, duplicates deduped, confirmed via server logs and direct SQLite row count (2.12).
- [x] **E1 run and result recorded in `architecture.md`.** Confirmed stable; D2 is now Final.
- [x] Tunnel and server torn down after live testing.

---

**Next:** Phase 3, worker and handlers — only after E1's answer is settled, since the worker's lease/dedupe model is built on top of whatever D2 ends up being.
