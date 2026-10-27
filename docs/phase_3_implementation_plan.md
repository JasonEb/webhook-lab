# Phase 3: Worker and Handlers — Detailed Steps

Companion to `architecture.md` and `implementation_plan.md`. Expands Phase 3 (4 to 5 h) into concrete steps. Builds on Phase 2's `DeliveryStore` and the now-confirmed D2 dedupe key. Unlike Phases 0 and 2, this phase needs **no live Quo interaction or tunnel** — it's pure internal logic, fully testable with an injected clock, per the plan's test strategy ("Deterministic time: inject clock and random so backoff tests need no sleeping").

**Goal of this phase:** a lease-based worker that claims, dispatches, retries with backoff, and dead-letters deliveries; idempotent handlers for the three target event types with order-independent, stale-guarded upserts; debug endpoints; and every processing-related row in `architecture.md`'s failure-modes table (section 7) backed by a passing test.

---

## 3.0 A gap carried over from Phase 2 that must be fixed first

`insertIfNew` (Phase 2) never set `next_run_at`, so it defaults to `NULL`. The worker's claim query needs `next_run_at <= now`, and in SQL, `NULL <= anything` is never true — so without this fix, **nothing inserted by Phase 2's ingest route would ever be claimed**. This wasn't a bug in Phase 2 (ingest never read `next_run_at`), but it is a blocker for Phase 3.

- [x] Fix `insertIfNew` in `src/db/sqliteDeliveryStore.ts` to set `next_run_at = receivedAt` on insert, so a freshly accepted delivery is immediately eligible for the worker. (Alternative considered and rejected: special-case `NULL` in the claim query with `COALESCE` — fixing it at insert time is simpler and means `next_run_at` is never `NULL` anywhere else in the codebase.)
- [x] Add a regression test in `src/app.test.ts` or a new worker test asserting a freshly-inserted row has a non-null `next_run_at` immediately after ingest.

## 3.1 Decisions this plan makes concretely (D9 and the backoff formula)

`architecture.md` D9 says "choose the lease duration when building the worker" — doing that now, with rationale, rather than leaving it a placeholder:

| Parameter | Value | Rationale |
|---|---|---|
| Lease duration | **30s** | Long enough for a simple synchronous upsert handler (milliseconds) with generous margin; short enough that crash recovery isn't painfully slow in a dev lab. Short enough that tests simulate expiry via an injected clock rather than real sleeping — no test should ever wait 30 real seconds. |
| `maxAttempts` | **5** | Small enough that a poison-event test reaches `dead` quickly; large enough to survive a couple of transient failures. Not specified in `architecture.md` — this is the project's first concrete value for it. |
| Backoff formula | `min(1000 * 2^(attempts-1), 60000) + jitter(0..250ms)` | Standard exponential backoff with a 60s cap and small jitter to avoid synchronized retries. With `maxAttempts=5`: delays of ~1s, 2s, 4s, 8s before the 5th and final attempt — the whole poison-event lifecycle resolves in under 16s in real time, and instantly under an injected clock in tests. |
| Worker poll interval | **500ms** | Arbitrary for a dev lab (not latency-tuned); configurable via a constructor parameter so tests don't need to wait on it (tests call `runOnce()` directly, see 3.4). |

- [x] If any of these feel wrong once the worker is running for real, change them — they're deliberate starting points, not something to debate before writing code.

## 3.2 Extend `DeliveryStore` for worker claims

New methods beyond Phase 2's `insertIfNew`/`countAll`. Takes an injected `now: Date` everywhere instead of calling `Date.now()` internally, so tests control time exactly.

`src/db/DeliveryStore.ts` additions:
```ts
export interface ClaimedDelivery {
  webhookId: string;
  eventType: string;
  payload: string;
  attempts: number;
}

export interface DeliveryStore {
  insertIfNew(args: { webhookId: string; eventType: string; payload: string; receivedAt: string }): InsertResult;
  countAll(): number;
  claim(now: Date, leaseMs: number): ClaimedDelivery | null;
  markDone(webhookId: string): void;
  markFailed(args: { webhookId: string; now: Date; attempts: number; maxAttempts: number; backoffMs: number; error: string }): void;
}
```

- [x] Extend the interface. Note `attempts` is passed back out of `claim()` and back in to `markFailed()` — the store doesn't decide retry policy (that's the worker's job, 3.4), it just records state.

## 3.3 SQLite implementation of claim/markDone/markFailed

Use a `db.transaction()` for `claim()` so the claim (including the `attempts` increment) is atomic — two worker loop iterations (or, later, two worker processes) must never claim the same row.

**Design choice: increment `attempts` at claim time, not at failure time.** This is what makes D9's "a crash during processing counts as an attempt when the row is reclaimed" work for free — a crashed claim already incremented `attempts`, so when the lease expires and another `claim()` picks it up, that's naturally a second attempt, with no separate crash-detection logic needed.

```ts
// added to src/db/sqliteDeliveryStore.ts

const claimTxn = db.transaction((now: Date, leaseMs: number): ClaimedDelivery | null => {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const row = db
    .prepare(
      `SELECT webhook_id, event_type, payload, attempts FROM deliveries
       WHERE status = 'pending' AND next_run_at <= ?
         AND (locked_until IS NULL OR locked_until <= ?)
       ORDER BY next_run_at LIMIT 1`,
    )
    .get(nowIso, nowIso) as { webhook_id: string; event_type: string; payload: string; attempts: number } | undefined;
  if (!row) return null;

  db.prepare(`UPDATE deliveries SET locked_until = ?, attempts = attempts + 1 WHERE webhook_id = ?`).run(
    leaseUntil,
    row.webhook_id,
  );

  return {
    webhookId: row.webhook_id,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts + 1,
  };
});
```

- [x] Implement `claim()` as above (SELECT then UPDATE inside one transaction, rather than relying on SQLite's `UPDATE ... RETURNING` — simpler to read and equally safe inside a `db.transaction()`).
- [x] Implement `markDone(webhookId)`: `UPDATE deliveries SET status = 'done' WHERE webhook_id = ?`.
- [x] Implement `markFailed()`: if `attempts >= maxAttempts`, `UPDATE ... SET status = 'dead', last_error = ?`; otherwise `UPDATE ... SET status = 'pending', next_run_at = ?, last_error = ?` using `now + backoffMs`. **Correction found by the tests, not anticipated in this plan:** leaving `locked_until` as-is was wrong, not harmless. A row that fails and gets a new, soon `next_run_at` is still blocked from reclaim by its *original* 30s lease, since `claim()` requires both `next_run_at <= now` AND the lease expired — the retry backoff and the lease fight each other. Fixed by also setting `locked_until = NULL` in the retry branch of `markFailed()`.

## 3.4 Worker loop

`src/worker.ts`:
```ts
import type { DeliveryStore } from "./db/DeliveryStore.js";
import type { DomainStore } from "./db/domainStore.js";
import { dispatchHandler } from "./handlers/index.js";

export interface WorkerConfig {
  leaseMs: number;
  maxAttempts: number;
  now: () => Date;
  random: () => number; // 0..1, injectable for deterministic jitter in tests
}

export function computeBackoffMs(attempts: number, random: () => number): number {
  const base = Math.min(1000 * 2 ** (attempts - 1), 60000);
  return base + Math.floor(random() * 250);
}

export async function runOnce(
  store: DeliveryStore,
  domainStore: DomainStore,
  config: WorkerConfig,
): Promise<"processed" | "empty"> {
  const claimed = store.claim(config.now(), config.leaseMs);
  if (!claimed) return "empty";

  try {
    const payload = JSON.parse(claimed.payload);
    await dispatchHandler(domainStore, claimed.eventType, payload);
    store.markDone(claimed.webhookId);
  } catch (err) {
    store.markFailed({
      webhookId: claimed.webhookId,
      now: config.now(),
      attempts: claimed.attempts,
      maxAttempts: config.maxAttempts,
      backoffMs: computeBackoffMs(claimed.attempts, config.random),
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return "processed";
}

export function startWorkerLoop(
  store: DeliveryStore,
  domainStore: DomainStore,
  config: WorkerConfig,
  pollMs: number,
): () => void {
  const interval = setInterval(() => {
    runOnce(store, domainStore, config).catch((err) => console.error("worker loop error", err));
  }, pollMs);
  return () => clearInterval(interval);
}
```

- [x] Create this file. **Deviation from this plan's sketch:** `runOnce`/`startWorkerLoop` take an injected `dispatch: (eventType, payload) => Promise<void>` parameter instead of a hardcoded import of the real `dispatchHandler`. Needed for testability — the retry/poison/crash tests (3.9) need a stub handler that fails predictably across calls, which isn't possible if `runOnce` always calls the one real handler. `handlers/index.ts` now exports `makeDispatchHandler(domainStore)` (a closure) instead of a function taking `domainStore` as a parameter; `server.ts` passes `makeDispatchHandler(domainStore)` into `startWorkerLoop`. `runOnce()` is the unit the tests (3.9) drive directly — fully synchronous from the test's point of view (no real waiting), since `now` and `random` are injected.
- [x] `startWorkerLoop()` is what `server.ts` actually calls for the real process; it returns a stop function (useful if a future phase wants graceful shutdown, and for any test that does start a real loop — avoid leaking a `setInterval` past a test's lifetime).
- [x] Note `runOnce` processes **one** claimable row and returns. A real loop calls it repeatedly on the poll interval; this keeps the core logic trivially testable without mocking `setInterval`.

## 3.5 Domain schema: `calls`, `summaries`, `messages`

Add to the schema (extend the schema module from Phase 2, or factor schema into its own file — see 3.5a).

```sql
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  event_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  call_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  event_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  event_at TEXT NOT NULL
);
```

Matches `architecture.md` section 5 exactly. `summaries` has no foreign key to `calls` by design (architecture.md 4.3 — order independence: a summary can arrive before its call).

### 3.5a Refactor: a shared `openDb()` instead of each store opening its own connection

Phase 2's `openDeliveryStore(path)` opened its own `better-sqlite3` connection internally. Phase 3 needs the **same** connection shared between `DeliveryStore` and the new domain stores — not for correctness (SQLite handles multiple connections fine), but because `app.ts`/`server.ts`/tests should only manage one database file/handle, and `:memory:` databases in particular are per-connection (two separate `new Database(':memory:')` calls are two separate empty databases, not the same one).

- [x] Add `src/db/openDb.ts`: exports `openDb(path: string): Database.Database`, runs the **full** schema (deliveries + calls + summaries + messages) in one place.
- [x] Change `openDeliveryStore(db: Database.Database): DeliveryStore` to accept an already-open `db` instead of a `path` (breaking change from Phase 2's signature — update `src/server.ts` and `src/app.test.ts` call sites).
- [x] Add `src/db/domainStore.ts` exporting `openDomainStore(db: Database.Database): DomainStore` (see 3.6).
- [x] `src/server.ts` becomes: `const db = openDb("data/dev.sqlite"); const store = openDeliveryStore(db); const domainStore = openDomainStore(db);`.

## 3.6 Domain store: generic upsert with stale guard

All three tables share an identical shape (`id`/`call_id` as PK, `data`, `event_at`), so one small generic helper avoids three near-copies of the same upsert logic — this is three *tables*, not three *concepts*, so a shared helper here is proportionate, not premature abstraction.

`src/db/domainStore.ts`:
```ts
import type Database from "better-sqlite3";

export interface DomainStore {
  upsertCall(id: string, data: unknown, eventAt: string): void;
  upsertSummary(callId: string, data: unknown, eventAt: string): void;
  upsertMessage(id: string, data: unknown, eventAt: string): void;
}

function makeUpsert(db: Database.Database, table: string, idColumn: string) {
  const stmt = db.prepare(
    `INSERT INTO ${table} (${idColumn}, data, event_at) VALUES (?, ?, ?)
     ON CONFLICT (${idColumn}) DO UPDATE SET data = excluded.data, event_at = excluded.event_at
     WHERE excluded.event_at >= ${table}.event_at`,
  );
  return (id: string, data: unknown, eventAt: string) => {
    stmt.run(id, JSON.stringify(data), eventAt);
  };
}

export function openDomainStore(db: Database.Database): DomainStore {
  const upsertCallFn = makeUpsert(db, "calls", "id");
  const upsertSummaryFn = makeUpsert(db, "summaries", "call_id");
  const upsertMessageFn = makeUpsert(db, "messages", "id");
  return {
    upsertCall: upsertCallFn,
    upsertSummary: upsertSummaryFn,
    upsertMessage: upsertMessageFn,
  };
}
```

- [x] Create this file. `table` is interpolated directly into SQL (not parameterized) — safe here only because it's always one of three hardcoded string literals from this module, never user input. Don't generalize this helper to accept an arbitrary table name from outside this file.
- [x] The `WHERE excluded.event_at >= ...` clause is the D10 stale guard, verbatim from `architecture.md` section 4.3.

## 3.7 Handlers and the D10 event-timestamp field per event type

`architecture.md` section 2 confirms the *rule* (use `data.resource.*`, not top-level `createdAt`) but only confirmed the *specific field* for `message.received` (`data.resource.createdAt`). `call.completed`'s field is a reasonable, not-yet-directly-confirmed choice; `call.summary.completed`'s payload shape hasn't been captured at all yet.

| Event type | Resource field used for `event_at` | Confidence |
|---|---|---|
| `message.received` | `data.resource.createdAt` | Confirmed (Phase 0, real capture) |
| `call.completed` | `data.resource.completedAt` | Provisional — semantically sound (the call's actual end time), matches the field name seen in the synthetic test payload (`fixtures/sample-delivery.json`), but not yet confirmed against a *real* call |
| `call.summary.completed` | `data.resource.updatedAt` (best guess) | **Open** — no `call.summary.completed` payload has been captured yet, real or synthetic. Field name is a guess based on the pattern of the other two, not evidence. |

- [x] Put this mapping in one place, not scattered across handler functions: `src/handlers/eventTimestampField.ts` exporting a small `Record<string, string>` or a switch — so updating it later (once a real call/summary payload is captured) is a one-line change, not a hunt through handler code.
- [x] **Done, 2026-10-27, and it caught a real bug.** A real call produced both `call.completed` and `call.summary.completed`. `call.completed`'s real resource matched the synthetic test payload exactly, confirming `completedAt`. **`call.summary.completed` had no resource-level timestamp at all** — the provisional `updatedAt` guess didn't exist, and the worker correctly retried it to `dead` with `NOT NULL constraint failed: summaries.event_at` (nice bonus confirmation that dead-lettering works against real failures, not just synthetic ones in tests). Fixed by falling back to the top-level `createdAt` for this one event type specifically — the general "always use `data.resource.*`" rule's premise (every resource has its own timestamp) doesn't hold here, which is an exception, not a violation. Verified the fix against the real stored payload directly (replayed it through the corrected handler) before writing it up. `architecture.md` section 2 and D10 (section 6) updated; regression tests added in `src/handlers/index.test.ts`.

`src/handlers/index.ts`:
```ts
import type { DomainStore } from "../db/domainStore.js";
import { EVENT_TIMESTAMP_FIELD } from "./eventTimestampField.js";

export async function dispatchHandler(store: DomainStore, eventType: string, payload: any): Promise<void> {
  const field = EVENT_TIMESTAMP_FIELD[eventType];
  if (!field) throw new Error(`No handler for event type: ${eventType}`);
  const eventAt = payload.data.resource[field];

  switch (eventType) {
    case "call.completed":
      store.upsertCall(payload.data.resource.id, payload.data.resource, eventAt);
      return;
    case "call.summary.completed":
      // The summary's resource shape isn't confirmed yet (see table above) — this assumes
      // a `callId` field exists on the resource, pointing back to the call. Confirm this
      // field name against a real captured payload before trusting it in production.
      store.upsertSummary(payload.data.resource.callId, payload.data.resource, eventAt);
      return;
    case "message.received":
      store.upsertMessage(payload.data.resource.id, payload.data.resource, eventAt);
      return;
    default:
      throw new Error(`No handler for event type: ${eventType}`);
  }
}
```

- [x] Create this file and `src/handlers/eventTimestampField.ts`.
- [x] Flag the same open question for `call.summary.completed`'s resource shape (not just its timestamp field) in the code comment, as shown above — the field name used to join a summary back to its call (`callId`? `call_id`? something else?) is equally unconfirmed.
- [x] An unrecognized `eventType` throws — this is correct behavior for the worker (it becomes a `markFailed`, eventually `dead`), not a silent no-op. The subscription only requests the three handled event types (Phase 0), so this should never fire in practice, but a handler must not pretend to succeed on something it didn't process.

## 3.8 Debug endpoints

Add to `src/app.ts` (or a separate `src/debugRoutes.ts` mounted into the same app, if `app.ts` is getting long — decide based on how it reads once written).

- [x] `GET /healthz` → `200 { status: "ok" }`.
- [x] `GET /debug/deliveries` → recent rows from `deliveries` (status, attempts, event_type, received_at — not the raw `payload`, per architecture.md section 8's "no payload bodies" rule, which section 9 extends to debug output, not just logs).
- [x] `GET /debug/stats` → counts by `deliveries.status`, plus arrival outcome counts if easily available (arrivals aren't a table yet, per D8 — a rough in-process counter incremented alongside `logArrival`/`logRejection` is enough for now; don't build the `arrivals` table early just to power this endpoint, that's explicitly deferred to Phase 4).
- [x] These are debug endpoints for a personal dev lab, not a public API — no auth needed, but don't bind to anything but `localhost` by habit (the `PORT`/`app.listen()` setup from Phase 2 already does this implicitly; just don't change that).

## 3.9 Tests

All of these use `runOnce()` directly with an injected `now`/`random` — no real waiting, per the plan's "Deterministic time" test strategy.

- [x] **Success path**: insert a delivery, `runOnce()`, assert `status = 'done'` and the domain row exists with the right `event_at`.
- [x] **Handler throws then succeeds on retry**: a handler stub that throws on the first call and succeeds on the second (a closure counting calls). First `runOnce()` → `status = 'pending'`, `next_run_at` advanced by the expected backoff, `attempts = 1`. Advance the injected clock past `next_run_at`, second `runOnce()` → `status = 'done'`.
- [x] **Poison event reaches `dead`**: a handler stub that always throws. Call `runOnce()` (advancing the injected clock past each `next_run_at` between calls) `maxAttempts` times; assert `status = 'dead'` after the last one and `status` never flips back to `pending` on a further `runOnce()` call (a `dead` row must not be claimable).
- [x] **Crash mid-processing (lease expiry) reclaims the row**: call `store.claim()` directly (not `runOnce()`, to simulate "claimed but the process died before `markDone`/`markFailed`"), don't call either resolution method, advance the injected clock past the lease duration, call `claim()` again — assert it returns the same row with `attempts` incremented a second time (confirms D9's "a crash counts as an attempt").
- [x] **Out-of-order summary-before-call**: upsert a summary via `domainStore.upsertSummary()` for a `call_id` that doesn't exist in `calls` yet, then upsert the call. Assert a join query (`SELECT * FROM calls JOIN summaries ON calls.id = summaries.call_id WHERE calls.id = ?`) returns both rows correctly — confirms no FK constraint blocks the out-of-order write.
- [x] **Stale event does not overwrite newer data**: upsert a call with `event_at = T2`, then upsert the same call id with `event_at = T1` (earlier) and different `data`. Assert the stored row still has the `T2` data/timestamp, not `T1`'s.

## 3.10 Structured logging without payloads

- [x] Worker logs: one structured line per `runOnce()` outcome (`processed`/`empty`), and on `processed`, whether it ended in `done`/`pending` (retry scheduled)/`dead`. Fields: `webhook_id`, `event_type`, `attempts`, `outcome`, `duration_ms` — matching architecture.md section 9's field list. No `payload` field, ever — confirm by reading the log call sites, not just by eyeballing one sample log line.

## 3.11 Acceptance checklist (must all be true to close Phase 3)

Tie directly to `architecture.md`'s failure-modes table (section 7) — every row that concerns *processing* (as opposed to ingest, which Phase 2 already covered) needs a passing test:

- [x] 3.0's `next_run_at` fix is in, with a regression test — without it nothing else in this phase can work.
- [x] `DeliveryStore.claim`/`markDone`/`markFailed` implemented and match D9 exactly (lease-based, `attempts` incremented at claim time, not failure time).
- [x] **"Handler throws"** row: tested (3.9) — worker retries with backoff, ingest already returned 200 so Quo doesn't see it.
- [x] **"Poison event"** row: tested (3.9) — reaches `dead` after `maxAttempts`, stays queryable (visible via `/debug/deliveries`), doesn't block the queue (a later `runOnce()` claims the *next* eligible row, not the dead one — worth an explicit assertion, not just an implication).
- [x] **"Crash mid-processing"** row: tested (3.9) — lease expiry reclaims the row, re-execution is safe because handlers are idempotent (upserts, not appends).
- [x] **"Out-of-order events"** row: tested (3.9) — summary-before-call join reads correctly.
- [x] Stale-guard behavior (D10) tested (3.9) independent of ordering — an explicitly older event never overwrites newer data.
- [x] `calls`/`summaries`/`messages` schema matches `architecture.md` section 5 exactly.
- [x] Debug endpoints (`/healthz`, `/debug/deliveries`, `/debug/stats`) exist and don't leak raw payloads.
- [x] `tsc --noEmit` and `eslint .` both pass clean.
- [x] All Phase 1/2 tests still pass (14 previously + however many this phase adds) — the `openDeliveryStore` signature change (3.5a) is the one thing in this phase that touches already-shipped code, so this is the regression check that matters most. Final count: 22/22.
- [x] Live local smoke test (new QA step, not in this plan's original scope): ran the real server, POSTed two locally-signed deliveries (`message.received`, `call.completed`), confirmed `accepted` → worker `done` end to end via structured logs, then screenshotted `/debug/deliveries` and `/debug/stats` (headless Chrome) to visually confirm no payload/PII leakage — both showed only ids/status/counts, as designed.
- [x] The `call.completed`/`call.summary.completed` event-timestamp fields (3.7) have been checked against a real (non-test) call — `call.completed` confirmed, `call.summary.completed` corrected (no resource-level timestamp exists; falls back to top-level `createdAt`). `architecture.md` section 2 updated. **Phase 3 is now fully closed.**

---

**Next:** Phase 4, fault injection and the retry experiments (E2–E8) — the worker and handlers this phase builds are what the fault injector sits in front of, and what the experiments measure the behavior of.
