# Phase 4: Fault Injection and the Retry Experiments — Detailed Steps

Companion to `architecture.md` and `implementation_plan.md`. Expands Phase 4 (4 to 6 h) into concrete steps. Builds on Phase 3's worker. This phase has two halves: build the fault injector, `arrivals` table, and analyzer CLI (pure code, testable); then run E2–E7 live against Quo (manual, one experiment at a time, per `implementation_plan.md`'s instruction to use fresh test events for each).

**Scope correction up front:** `implementation_plan.md`'s experiment table lists **E8** ("Does reconciliation recover an outage?") under Phase 4, but the reconciler it depends on is explicitly a **Phase 5** deliverable (`implementation_plan.md` Phase 5 task list). E8 is deferred to after Phase 5 — flagged here rather than silently skipped or attempted without the tool it needs.

**Goal of this phase:** `FAULT_MODE` (`fail_first:N`, `slow:MS`, plus an extension needed for E4 — see 4.1), the `arrivals` table promoted per D8, an analyzer CLI, and E2–E7 run with results recorded (E1 already done in Phase 2).

---

## 4.0 Two gaps in the master plan found while reading it closely for this phase

Both worth fixing in the plan before writing code, not discovering mid-experiment:

1. **E4 needs a capability `FAULT_MODE` doesn't have.** `architecture.md` 4.4 defines exactly two modes (`fail_first:N`, `slow:MS`). Neither lets you force an arbitrary status code (400, 401, 404, 410, 429, 503, a 3xx) for E4's "which status codes are retried" experiment. `FAULT_MODE` needs a third variant: `status:<code>:<n>` (respond with `<code>` to the first `<n>` arrivals of each event, default `n=1`, same counting mechanism as `fail_first`). This is a genuine extension beyond what `architecture.md` currently documents — add it there once built, don't just quietly implement it.
2. **E3's "record" column assumes a field that doesn't exist.** `implementation_plan.md` says to record "response duration shown in Quo's attempt detail" — but `architecture.md` section 2 already corrected this (Phase 2, `plan_deviations.md` V3): the real `GET /webhooks/{webhookId}/events` response has no `responseDurationMs` field (that was a third-party-sourced guess that didn't hold up). E3 can only be measured from **our own** arrival timestamps (did Quo retry at all, and when), not cross-checked against a Quo-reported duration. Don't go looking for a field that isn't there.

## 4.1 `FAULT_MODE` parsing, including the E4 extension

`src/faultInjector.ts`:
```ts
export type FaultMode =
  | { type: "none" }
  | { type: "fail_first"; n: number }
  | { type: "slow"; ms: number }
  | { type: "status"; code: number; n: number };

export function parseFaultMode(raw: string | undefined): FaultMode {
  if (!raw || raw === "none") return { type: "none" };
  const [kind, ...rest] = raw.split(":");
  if (kind === "fail_first") return { type: "fail_first", n: Number(rest[0]) };
  if (kind === "slow") return { type: "slow", ms: Number(rest[0]) };
  if (kind === "status") return { type: "status", code: Number(rest[0]), n: Number(rest[1] ?? 1) };
  throw new Error(`Invalid FAULT_MODE: ${raw}`);
}

export interface FaultDecision {
  statusCode: number | null; // null = proceed normally; otherwise short-circuit with this code
  delayMs: number;
}

export function decideFault(mode: FaultMode, priorArrivalCount: number): FaultDecision {
  switch (mode.type) {
    case "fail_first":
      return { statusCode: priorArrivalCount < mode.n ? 500 : null, delayMs: 0 };
    case "status":
      return { statusCode: priorArrivalCount < mode.n ? mode.code : null, delayMs: 0 };
    case "slow":
      return { statusCode: null, delayMs: mode.ms };
    default:
      return { statusCode: null, delayMs: 0 };
  }
}
```

- [x] Create this file. `priorArrivalCount` comes from the `arrivals` table (4.2) — how many times this event's `webhook_id` has already arrived, faulted or not.
- [x] **Safety, per `architecture.md` 4.4 ("must never be enabled in a real deployment")**: on server startup, if `parseFaultMode(process.env.FAULT_MODE).type !== "none"`, log a loud, impossible-to-miss warning banner (not just a normal structured log line) to stderr. Don't add a second confirmation env var gate beyond this — `FAULT_MODE` already defaults to `"none"` and requires deliberate action to set, which is the actual safety mechanism; a second flag would be redundant ceremony, not real protection.

## 4.2 Promote `arrivals` to a table (D8), with one deliberate schema addition

`architecture.md` section 5's documented schema: `arrivals(id PK, webhook_id, event_type, received_at, ts_header, outcome [accepted|duplicate|faulted])`.

**Deliberate addition beyond that schema:** a nullable `label TEXT` column, so each experiment run can be tagged (e.g. `"E2"`, `"E3-slow-5000"`) and the analyzer (4.4) can filter/aggregate per experiment — `architecture.md` section 4.6 already says the analyzer should aggregate "per fault scenario," which isn't possible from `webhook_id`/`received_at` alone once more than one experiment has run. Flag this as a schema addition in `plan_deviations.md` once built, not a silent change.

```sql
CREATE TABLE IF NOT EXISTS arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ts_header TEXT NOT NULL,
  outcome TEXT NOT NULL,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_arrivals_webhook_id_received ON arrivals(webhook_id, received_at);
```

`src/db/arrivalStore.ts`:
```ts
export interface ArrivalRow {
  webhookId: string;
  eventType: string;
  receivedAt: string;
  tsHeader: string;
  outcome: "accepted" | "duplicate" | "faulted";
  label: string | null;
}

export interface ArrivalStore {
  record(row: ArrivalRow): void;
  countForWebhookId(webhookId: string): number;
  listAll(filter?: { sinceIso?: string; label?: string }): ArrivalRow[];
}
```

- [x] Add the table to `src/db/openDb.ts`'s schema.
- [x] Implement `src/db/arrivalStore.ts` similarly to the existing stores (prepared statements, shared `db` connection).
- [x] Keep `arrivalLog.ts`'s existing console logging (`logArrival`/`logRejection`) as-is — the table is the new queryable record, not a replacement for the live-tailable structured log.

## 4.3 Wire the fault injector into `app.ts`

Per `architecture.md` 4.4: "sits after verification and arrival logging so faulted attempts are still measured." This means the `arrivals` row is written (with `outcome: "faulted"` if applicable) *before* deciding the response — consistent with 4.2's `countForWebhookId` needing to count faulted attempts too.

**Interface change needed:** `createApp` currently takes `(store, secret)`. Growing to `(store, arrivalStore, secret, faultMode)` is unwieldy — bundle into one options object: `createApp({ store, arrivalStore, secret, faultMode, label })`. This is an intentional interface evolution for this phase, not a surprise found mid-implementation (unlike Phase 3's V4/V5) — document it as such.

Updated route flow:
1. Verify signature (unchanged — 401, no `arrivals` row, per Phase 2's existing design).
2. Parse JSON (unchanged — 400, no `arrivals` row, if malformed).
3. `const priorCount = arrivalStore.countForWebhookId(parsed.id);`
4. `const decision = decideFault(faultMode, priorCount);`
5. If `decision.delayMs > 0`: `await sleep(decision.delayMs)` — simulates a slow handler, delay happens before the rest of the work, not after.
6. If `decision.statusCode !== null`: record an `arrivals` row with `outcome: "faulted"`, respond with `decision.statusCode`, **do not** touch `deliveries` — return.
7. Otherwise: proceed exactly as Phase 2/3 built it (`store.insertIfNew`, `logArrival`), **plus** record the matching `arrivals` row (`outcome` mirrors the insert result: `accepted`/`duplicate`).

- [x] Implement the updated route in `src/app.ts`.
- [x] Update `src/server.ts` to read `FAULT_MODE` from the environment (default unset/`"none"`), construct the `ArrivalStore`, and pass everything into `createApp`.
- [x] Update `src/app.test.ts`'s `setup()` helper for the new `createApp` signature (pass `faultMode: { type: "none" }` and a fresh `arrivalStore` by default, so Phase 2/3's existing 4 tests don't need to change their assertions, only their setup call).

## 4.4 Tests for the fault injector

- [x] `parseFaultMode`: each valid format (`none`, `fail_first:N`, `slow:MS`, `status:CODE:N`, `status:CODE` with default `n=1`), and an invalid string throws.
- [x] `decideFault`: `fail_first:3` faults attempts 0/1/2 (statusCode 500), passes attempt 3+ (statusCode null). `status:429:2` faults attempts 0/1 with 429, passes attempt 2+. `slow:100` never faults, always returns `delayMs: 100`. `none` never faults, never delays.
- [x] Route-level test: `FAULT_MODE=fail_first:2` via `createApp`'s injected `faultMode` — first two requests for the same `webhook_id` get 500 and an `arrivals` row with `outcome: "faulted"` each, no `deliveries` row; the third gets 200, `accepted`, and exactly one `deliveries` row. Confirms the counting logic end-to-end, not just the pure function.
- [x] Route-level test: `FAULT_MODE=slow:50` — response takes at least 50ms (assert via a timer around the request) and still returns 200/`accepted`.

## 4.5 Analyzer CLI

`scripts/analyze.ts`:
```ts
import { openDb } from "../src/db/openDb.js";
import { openArrivalStore } from "../src/db/arrivalStore.js";

// Parse --db, --label, --since, --csv from process.argv (keep this simple — a dev CLI for
// personal use, not a general-purpose argument parser library).
```

- [x] For each distinct `webhook_id` in the filtered result set: print arrival timestamps in order, inter-arrival gaps (ms between consecutive arrivals), and the outcome sequence (e.g. `faulted, faulted, faulted, accepted`).
- [x] Aggregate across the filtered set: total attempts, min/max/mean gap, a simple bucketed distribution (e.g. `<1s`, `1-5s`, `5-30s`, `>30s`).
- [x] `--label <label>` filters to one experiment run (per 4.2's schema addition).
- [x] `--csv <path>` exports the raw filtered rows (not just the aggregates) to CSV, per `implementation_plan.md`'s "export to CSV" task — this is what gets saved into `data/experiments/`.
- [x] Add an `npm run analyze -- [args]` script to `package.json`.

## 4.6 Experiment runbook (live, one at a time)

General pattern for each experiment: set `FAULT_MODE` in `.env`, restart the server, confirm the tunnel/subscription are pointed correctly (same dance as Phases 0/2/3 — fresh tunnel each session, `PATCH /webhooks/47119` to repoint), trigger **one fresh event**, wait, run the analyzer with `--label <experiment-id>`, record the one-paragraph result below, **then set `FAULT_MODE` back to `none` and restart** before moving to the next experiment — never leave fault injection on between experiments.

| Experiment | `FAULT_MODE` | What to trigger | What to record |
|---|---|---|---|
| **E2** — automatic retry schedule | `fail_first:100` | One real or test event | Arrival gaps until Quo stops retrying (if it ever does within a reasonable wait); total attempts observed. This is the schedule/backoff/max-attempts unknown from `architecture.md` section 2. |
| **E3** — delivery timeout | `slow:2000`, then separately `slow:5000`, `slow:10000`, `slow:30000` (four separate runs, four fresh events) | One fresh event per `slow` value | Whether Quo retries at each delay (implies a timeout was hit) — **from our own arrival timestamps only**, per 4.0's correction, not a Quo-reported duration field. |
| **E4** — which status codes retry | `status:<code>:1` — **trimmed to 400, 429, 500, 503** (4 codes, not the original 8) once every code was found to need its own real-event trigger (see `plan_deviations.md` V10) | One fresh event per code (4 runs) | Retry or no retry, per code. This is the extension built in 4.1 — wasn't possible with the master plan's original `FAULT_MODE` alone. |
| **E5** — bad signature / secret rotation | `none` (uses the existing signature path, not the fault injector) | Temporarily set a wrong value in `.env`'s `QUO_WEBHOOK_SECRET`, send an event, observe; then call `POST /webhooks/47119/rotate`, update `.env` with the new secret, confirm recovery | Whether Quo retries a 401; the manual recovery procedure, written down step by step (this doubles as real operational documentation, not just an experiment result). |
| **E6** — does repeated failure disable the subscription | `fail_first:100`, left running across several distinct events (not just one) | Several fresh events over the run | `GET /webhooks` subscription `status` field, checked before/during/after. |
| **E7** — are events ordered | `none` | A real call that produces `call.completed` and `call.summary.completed` in quick succession (Phase 3's real-call test already showed roughly an 8s gap between them) | Arrival order (from `arrivals`) versus the events' own `data.resource` timestamps (confirmed field names from Phase 3) — do they ever arrive out of order relative to when they actually happened? |
| ~~E8~~ | — | — | **Deferred to after Phase 5** — needs the reconciler, which doesn't exist yet (4.0). |

- [x] Run E2 through E7, each producing a labeled CSV export under `data/experiments/` via the analyzer. (E2 needed two sessions across a day boundary; everything else ran in one sitting.)
- [x] Write one paragraph per experiment with the result, in `data/experiments/README.md` (not `FINDINGS.md`, which stays a Phase 5 deliverable).
- [x] Flagged where results contradict prior assumptions: E4's finding that 4xx retries exactly like 5xx (contradicts common webhook-provider convention, not an `architecture.md` assumption specifically, since that was genuinely unknown beforehand) is called out explicitly in both `data/experiments/README.md` and `architecture.md`'s "Failure mode" row.

## 4.7 Acceptance checklist (must all be true to close Phase 4)

- [x] `FAULT_MODE` implemented with all three variants (`fail_first`, `slow`, and the `status` extension for E4), defaulting to `none`, with a loud startup warning when active. Verified live locally, not just in tests.
- [x] `arrivals` table promoted per D8, with the `label` addition flagged in `plan_deviations.md` (V9).
- [x] Fault injector sits after verification and arrival logging, confirmed by reading `app.ts` (matches `architecture.md` 4.4 exactly).
- [x] Unit tests (4.4) pass, including the route-level end-to-end fault behavior, not just the pure `decideFault` function.
- [x] Analyzer CLI works: per-`webhook_id` gaps, aggregates, `--label` filtering, CSV export. Verified against live local smoke-test data.
- [x] `tsc --noEmit` and `eslint .` both pass clean; all prior tests pass. 38/38 total (26 from Phase 3 + 12 new).
- [x] E2–E7 run live, each with a recorded one-paragraph result and a raw CSV export under `data/experiments/`.
- [x] Any result contradicting prior assumptions is flagged in that experiment's write-up.
- [x] E8 explicitly deferred, not silently skipped — noted here, in `implementation_plan.md`, and in `data/experiments/README.md`'s scope for Phase 5 to pick up.
- [x] `FAULT_MODE` is back to `none`/unset (E7 and every subsequent action ran with no fault injection active). Tunnel teardown is on the project owner — reminded at session end.
- [ ] New bugs/deviations found while executing this phase logged in `bug_log.md`/`plan_deviations.md`, same habit as Phase 3.

---

**Next:** Phase 5, reconciler and write-up — builds the reconciler E8 depends on, and turns this phase's draft experiment notes into the polished `FINDINGS.md`.
