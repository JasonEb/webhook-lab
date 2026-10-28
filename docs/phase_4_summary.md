# Phase 4 Summary: Fault Injection and the Retry Experiments

Status: **Complete** (E1–E7; E8 deferred to after Phase 5). Executed 2026-10-27 through 2026-10-28 (spanned a day boundary mid-experiment). Companion to `architecture.md` and `phase_4_implementation_plan.md` — this is the after-the-fact record of what actually happened, not the plan. Bugs and plan deviations from this phase are tracked in `bug_log.md` (D2) and `plan_deviations.md` (V8–V10); this summary references them rather than repeating them.

## What was built

- `src/faultInjector.ts` — `FAULT_MODE` with three variants: `fail_first:N`, `slow:MS`, and `status:CODE:N` (a project-added extension, `plan_deviations.md` V8, since E4 needed a capability `architecture.md`'s original spec didn't have). Defaults to `none`; logs an unmissable warning banner when active, per `architecture.md` 4.4's "must never run in a real deployment."
- `src/db/arrivalStore.ts` + an `arrivals` table in `src/db/openDb.ts` — D8's promotion, finally done once the experiments needed queryable data, with one addition beyond the documented schema: a nullable `label` column (`plan_deviations.md` V9) so each experiment run can be filtered independently.
- `src/app.ts` refactored to an options-object `createApp()` signature to accommodate the growing parameter list (store, arrivalStore, secret, faultMode, label) — an intentional, planned evolution, not a surprise.
- `scripts/analyze.ts` — per-`webhook_id` arrival gaps, aggregate stats, bucketed gap distribution, `--label`/`--since` filtering, CSV export.
- 12 new tests (pure `parseFaultMode`/`decideFault` logic plus route-level end-to-end fault behavior), all passing.

## A real finding that changed the rest of the phase

The first live experiment (E2) revealed that **test-triggered deliveries (`POST /webhooks/:id/events/test`) never get retried at all**, no matter the response code — only real events go through Quo's actual retry machinery. This meant every subsequent experiment (E3–E6) had to use real texts/calls instead of the cheaper test-event trigger, which the master plan hadn't anticipated. Led directly to a scope conversation with the project owner and the E4 trim from 8 status codes to 4 (`plan_deviations.md` V10).

## The experiments

Full write-ups with raw data in `data/experiments/README.md`; here's the condensed picture:

| Experiment | Headline result |
|---|---|
| E2 — retry schedule | 4 attempts over ~39 min, growing but not cleanly-doubling gaps (4.2s → 5m37s → 32m54s). Ceiling not confirmed — observation stopped by deliberate scope decision. |
| E3 — delivery timeout | No retry at 2s/5s/10s; retry at 30s. Timeout bounded to (10s, 30s]. |
| E4 — which codes retry | All of 400/429/500/503 retried, ~5.1–5.2s consistently. **4xx retried exactly like 5xx** — flagged as contradicting common webhook-provider convention. |
| E5 — bad signature / rotation | 401 retries once, same ~5.2s timing. Rotation + config update recovers immediately. |
| E6 — auto-disable on failure | No change observed across 3 events/~90s. Explicitly not a "never happens" claim — long-duration test wasn't run. |
| E7 — ordering | One real call's causally-dependent pair (`call.completed`→`call.summary.completed`) arrived in order on every axis. Single trial of a dependent pair, not a general guarantee. |

## A bug this phase's own thoroughness caught

Running the full test suite one more time at the end of the phase (standard habit, not a special check) caught a real regression: E5's live secret rotation permanently broke a Phase 1 test that implicitly assumed the configured `QUO_WEBHOOK_SECRET` never changes. Not a product defect — `verifyQuoSignature` behaves correctly — but a test-design assumption invalidated by a deliberate later action. Logged as `bug_log.md` D2, fixed by retiring (not deleting) the affected assertion with an explanatory comment.

## Process notes

- First phase where live experiments spanned multiple sessions and a day boundary — required re-establishing the tunnel twice and repointing the subscription each time, same pattern as every prior live-testing phase.
- `Monitor` was used extensively to watch for retries without polling, including catching one retry (E2's 4th attempt) that arrived a few minutes after a monitor window had already expired — a reminder that "no events in N minutes" isn't the same as "no more events will ever come."

## Acceptance

- `tsc --noEmit` and `eslint .` clean; 37 passed + 1 deliberately retired (38 total).
- E1–E7 all have a recorded one-paragraph result, raw CSV data, and explicit flagging where results contradict prior assumptions (E4's 4xx finding especially).
- E8 explicitly deferred, not silently skipped — needs Phase 5's reconciler.
- `FAULT_MODE` left at `none`; subscription pointed at whatever tunnel was last active (tear down is on the project owner between sessions, per the established habit).

## Artifacts

- `src/faultInjector.ts`, `src/faultInjector.test.ts`, `src/db/arrivalStore.ts`, `scripts/analyze.ts`, `src/app.ts` (refactored), `src/app.test.ts` (fault tests added)
- `data/experiments/README.md` + `E2.csv` through `E7*.csv` (several per multi-run experiment)
- `architecture.md` section 2 updated (resolved/remaining unknowns), "Failure mode" row corrected
- `implementation_plan.md` Phase 4 section marked done with condensed results
- `bug_log.md` D2, `plan_deviations.md` V8–V10
- Not committed as of this summary.

---

**Next:** Phase 5, reconciler and write-up — builds the reconciler E8 depends on, and turns this phase's draft experiment notes into the polished `FINDINGS.md`.
