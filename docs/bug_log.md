# Bug Log

Running log of bugs/defects encountered during implementation, for the end-of-project report. Updated as phases proceed. "Found via" matters — a bug caught by a test before it ever ran live is a different story than one caught by a live failure.

Not included here: unresolved *unknowns* from `architecture.md` section 2 that got resolved (those are findings, not bugs — nothing was broken, something was unknown). Documentation corrections with no code impact also aren't logged here.

## Category 1: Product bugs (in the webhook-lab's own code)

| # | Phase | Bug | Root cause | Found via | Impact if unfixed | Fix |
|---|---|---|---|---|---|---|
| P1 | 3 | Freshly-ingested deliveries would never be picked up by the worker | `insertIfNew` never set `next_run_at`, defaulting to `NULL`. SQL `NULL <= now` is never true, so the worker's claim query would never match a fresh row. | Caught proactively while writing the worker's claim query (step 3.0), before any test ran — recognized as a necessary precondition, not discovered by a failure. | Total: nothing would ever process. Caught before it could cause one. | Set `next_run_at = receivedAt` at insert time. |
| P2 | 3 | A failed delivery's retry backoff was blocked by its own lease | `markFailed`'s retry path set a new, soon `next_run_at` but never cleared `locked_until` from the original claim. `claim()` requires both `next_run_at <= now` AND the lease expired, so a row scheduled to retry in 1s was actually stuck until the full 30s lease also passed. | A unit test failure (`worker.test.ts`, "retries with backoff... then succeeds") — expected `processed`, got `empty`. | Retries would appear to work (status correctly set to `pending`) but silently take up to 30x longer than the backoff schedule says. Would have been very confusing to debug later without the test. | `markFailed`'s retry branch also sets `locked_until = NULL`. |
| P3 | 3 | `call.summary.completed` handler guessed a timestamp field (`updatedAt`) that doesn't exist on the real resource | The real resource has no timestamp field at all — fields are `answeredByUserId`/`callId`/`fromPhoneNumber`/`handledByAiAgent`/`nextSteps`/`processingStatus`/`summary`. Built against a provisional guess before a real call had been captured (flagged as provisional at the time, per the Phase 3 plan). | A live test: a real call's summary event hit `NOT NULL constraint failed: summaries.event_at`, retried 5 times, and dead-lettered — correctly, per the worker's own logic. | Every real `call.summary.completed` event would dead-letter forever until fixed. Never shipped past local testing, but would have been a total miss on one of the three target event types. | Fall back to the top-level webhook `createdAt` for this event type specifically, documented as a deliberate exception rather than a violation of the general "use `data.resource.*`" rule. |

## Category 2: Tooling/environment issues (not application logic)

| # | Phase | Issue | Root cause | Found via | Fix |
|---|---|---|---|---|---|
| T1 | 0 | `npm install -D typescript-eslint` failed with a peer-dependency conflict | `npm install -D typescript` pulled TypeScript 7 (the new native compiler) by default; `typescript-eslint@8.72.1`'s peer range is `>=4.8.4 <6.1.0` — the ecosystem hasn't caught up to TS 7 yet. | `npm install` error output. | Pinned `typescript` to `^5.9.3` instead. |
| T2 | 0 | `eslint.config.js` threw `Cannot use import statement outside a module` | `npm init -y` defaulted `package.json`'s `"type"` to `"commonjs"`, but the config (and the rest of the codebase) uses `import`/`export`. | `npx eslint .` crash on first run. | Set `"type": "module"` in `package.json`. |
| T3 | 1 | `tsc --noEmit` failed once `scripts/capture-once.ts` existed | `tsconfig.json` had `"rootDir": "src"`, but the project has two source directories (`src/`, `scripts/`) — TS requires `rootDir` to contain every included file. | `npx tsc --noEmit` error. | Removed `rootDir` from `tsconfig.json`. |

## Category 3: Test-design flaws (the test was wrong, not the code)

| # | Phase | Flaw | Root cause | Found via | Fix |
|---|---|---|---|---|---|
| D1 | 1 | "Verify the real captured Phase 0 delivery" test failed hours after being written | The test replayed a fixture's signature verbatim via `verifyQuoSignature()`, which correctly enforces a 5-minute timestamp tolerance. Any captured fixture ages out of a literal replay — this is correct product behavior, not a bug in `verifyQuoSignature`. | `vitest run` failure (`Message timestamp too old`). | Split into two tests: cryptographic authenticity via `sign()` directly (bypasses wall-clock), and an explicit test that `verifyQuoSignature` *correctly* rejects the aged fixture as stale. |
| D2 | 4 | The cryptographic-authenticity half of D1's fix broke permanently | That test recomputes a fixture's expected signature using whatever secret is in `.env` *right now* and compares it to the fixture's stored signature — implicitly assuming the configured secret never changes. Phase 4's E5 experiment deliberately rotated the real webhook secret (`POST /webhooks/47119/rotate`) as part of testing the recovery procedure, and `.env` now holds the new secret permanently. | `vitest run` failure (`expected [...] to include '...'`) during Phase 4's final full-suite check — correctly caught by running the whole suite again after live experiments, not assumed clean. | Retired (not deleted) via `it.skip` with an explanatory comment in `src/verifyQuoSignature.test.ts`, cross-referencing E5. The fixture's authenticity was already established once against the original secret; re-verifying it forever against a secret that has since rotated isn't meaningful. The staleness-rejection test (D1's other half) is unaffected, since timestamp tolerance is checked before signature comparison. |

## Running totals

- **Product bugs:** 3 (all Phase 3, all caught before reaching a committed/shipped state)
- **Tooling/environment issues:** 3 (all Phase 0–1, all one-time scaffold friction)
- **Test-design flaws:** 2 (Phase 1, Phase 4 — both are the same underlying fixture-permanence lesson, surfacing twice in different forms)

---

*Update this file whenever a new bug is found — append a row to the right category table and bump the running totals. Don't log a resolved "unknown" or a pure documentation fix here; those belong in `architecture.md`'s own history, not this log.*
