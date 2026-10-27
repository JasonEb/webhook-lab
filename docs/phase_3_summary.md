# Phase 3 Summary: Worker and Handlers

Status: **Complete**. Executed 2026-10-27. Companion to `architecture.md` and `phase_3_implementation_plan.md` — this is the after-the-fact record of what actually happened, not the plan. Bugs and plan deviations from this phase are tracked in full in `bug_log.md` (P1–P3) and `plan_deviations.md` (V4–V6); this summary references them rather than repeating them.

## What was built

- `src/db/openDb.ts` — shared schema (all four tables: `deliveries`, `calls`, `summaries`, `messages`) and shared connection, replacing Phase 2's per-store connection (`plan_deviations.md` V4).
- `src/db/DeliveryStore.ts`/`sqliteDeliveryStore.ts` — extended with `claim`/`markDone`/`markFailed`/`listRecent`/`countsByStatus`. `attempts` increments at claim time, not failure time, so a crash and a reclaim fall out of the same code path (D9).
- `src/db/domainStore.ts` — generic upsert/getter helpers shared across `calls`/`summaries`/`messages` (same shape, one small helper rather than three near-copies).
- `src/worker.ts` — `runOnce`/`startWorkerLoop`, with an injectable `dispatch` function rather than a hardcoded handler import (`plan_deviations.md` V5 — needed for the retry/poison/crash tests to work at all).
- `src/handlers/` — `eventTimestampField.ts` + `index.ts` (`makeDispatchHandler`), implementing D10's stale-event guard per event type.
- `/healthz`, `/debug/deliveries`, `/debug/stats` added to `src/app.ts`, backed by in-process arrival counters (`arrivalLog.ts`).
- Concrete values chosen for D9 (previously just "choose it when building the worker"): 30s lease, 5 max attempts, exponential backoff capped at 60s with jitter.

## Bugs found and fixed this phase

Three product bugs, full detail in `bug_log.md`:
- **P1** — `next_run_at` was never set on insert (Phase 2 gap), meaning nothing would ever be claimable. Caught proactively before any test ran, not via a failure.
- **P2** — `markFailed`'s retry path didn't clear `locked_until`, so a scheduled retry was blocked by its own original lease until the full 30s passed, not just the backoff delay. Caught by a unit test.
- **P3** — `call.summary.completed`'s timestamp field was a guess (`updatedAt`) that doesn't exist on the real resource. Caught by a **real call** — the event correctly dead-lettered 5 times before the fix, which also happened to confirm the dead-lettering logic works against a genuine failure, not just a synthetic one in tests.

## The real-call verification step

Per the plan's acceptance checklist, Phase 3 wasn't allowed to close with `call.completed`/`call.summary.completed`'s timestamp fields as unconfirmed guesses. A real call was placed; `call.completed`'s resource matched the synthetic test payload's field set exactly (`completedAt` confirmed). `call.summary.completed` had no resource-level timestamp at all — real fields are `answeredByUserId`/`callId`/`fromPhoneNumber`/`handledByAiAgent`/`nextSteps`/`processingStatus`/`summary`. Fixed by falling back to the top-level webhook `createdAt` for that one event type, documented in `architecture.md` as an explicit exception to D10's general rule rather than a violation of it (`plan_deviations.md` V6).

The fix was verified by replaying the real stored payload (the `deliveries.payload` column retains the raw body) through the corrected handler directly, before writing it up — not just trusted in theory.

## QA process established this phase

First use of a new per-phase QA step: screenshotting the debug endpoints after live testing to visually confirm no payload/PII leakage, not just asserting it in code. No browser automation tool was actually connected in this session (despite being available in principle), so this used headless Chrome via the shell instead — both `/debug/deliveries` and `/debug/stats` showed only ids/status/counts, confirming the "no payload bodies" design constraint held in practice.

## Acceptance

- 26/26 tests passing (22 from the implementation pass + 4 added when P3's fix needed regression coverage), `tsc --noEmit` and `eslint .` both clean.
- Every processing-related row in `architecture.md`'s failure-modes table (section 7) has a passing test: handler throws, poison event, crash mid-processing, out-of-order events, stale guard.
- Live local smoke test (synthetic signed requests) and a live real-call test (actual Quo infrastructure) both confirmed end-to-end: ingest → worker → domain table, correctly.

## Artifacts

- `src/worker.ts`, `src/worker.test.ts`, `src/db/openDb.ts`, `src/db/domainStore.ts`, `src/db/domainStore.test.ts`, `src/db/sqliteDeliveryStore.test.ts`, `src/handlers/eventTimestampField.ts`, `src/handlers/index.ts`, `src/handlers/index.test.ts`
- `architecture.md` updates: D2/D10 finalized with real-world nuance, per-event-type timestamp fields all confirmed
- `bug_log.md` (P1–P3), `plan_deviations.md` (V4–V6) — first phase tracked in both logs
- Not committed as of this summary.

---

**Next:** Phase 4, fault injection and the retry experiments (E2–E8) — the worker this phase built is what the fault injector sits in front of, and what the experiments measure the behavior of.
