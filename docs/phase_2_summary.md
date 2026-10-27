# Phase 2 Summary: Ingest, Arrival Log, and Dedupe

Status: **Complete**. Executed 2026-10-27. Companion to `architecture.md` and `phase_2_implementation_plan.md` — this is the after-the-fact record of what actually happened, not the plan.

## What was built

- `src/db/DeliveryStore.ts` — storage interface (D3), with `insertIfNew()` and `countAll()`. `countAll()` wasn't in the original plan sketch; added to assert "exactly one row" in tests without reaching into SQLite internals, and it doubles as a building block for `/debug/stats` later.
- `src/db/sqliteDeliveryStore.ts` — SQLite implementation. `deliveries` table only, per D8 (no `arrivals` table yet). WAL mode set (confirmed harmless on `:memory:` — silently falls back to `memory` journal mode rather than erroring, verified empirically before relying on it).
- `src/arrivalLog.ts` — `logArrival()` (the documented `accepted`/`duplicate`/`faulted` outcomes) and `logRejection()` (signature/parse failures, kept separate rather than inventing a fourth outcome value the docs don't define).
- `src/app.ts` — the real Express route, `createApp(store, secret)`. `express.raw()` mounted only on `/webhooks/quo`. Dedupes on the payload body's `id` field.
- `src/testSupport/sign.ts` — shared signing helper, extracted from Phase 1's test file to avoid duplicating the same logic.
- `src/app.test.ts` — 4 tests: accepted, duplicate (exactly one row), bad signature (401), malformed JSON (400).
- `src/server.ts` — real entrypoint (`app.listen()`), separate from `app.ts` so tests never need a real port.
- New deps: `supertest`, `@types/supertest`, `@types/better-sqlite3` (the last one wasn't anticipated — `better-sqlite3` ships no types of its own, `tsc` caught it immediately).

## Live verification

- Fresh tunnel, subscription repointed via `PATCH /webhooks/{webhookId}` — an update endpoint that exists but wasn't in the original architecture.md citation (found via the docs' `llms.txt` index).
- Real server run, test events fired via the API: `200` + `accepted` on first send, `200` + `duplicate` + unchanged row count on a repeat — confirmed via both the server's structured logs and a direct SQLite query, not just the HTTP status.

## The major finding: two different IDs, and E1

While hunting for the delivery-listing endpoint (needed to find something to retry for E1), the real API response revealed something `architecture.md` hadn't distinguished: a delivery has both an `id` (delivery-level, equals the `webhook-id`/`svix-id` HTTP header) and an `eventId` (the payload body's own `id` field — what the app actually dedupes on). These are **different values**, not two names for the same thing. Test-triggered deliveries always have `eventId: null`, which is also why a real (non-test) event was needed for E1, not another canned test trigger.

**E1 result: both identifiers are stable across a manual retry.** Confirmed two ways — the delivery-list API showed no new entry after the retry (same `id`, same `eventId`, same `createdAt`), and a temporary diagnostic log (added to `app.ts`, then reverted) confirmed the actual re-received HTTP request's `webhook-id` header matched the original exactly. D2 is now **Final** in `architecture.md` — the dedupe-on-payload-`id` approach, already how `app.ts` was built, is confirmed correct.

Caveat carried forward: this tested a *manual* retry only. Automatic retries (after a real failure/timeout) are expected to behave the same way but haven't been directly observed — Phase 4's fault-injection experiments (E2) will confirm this naturally rather than requiring a dedicated check now.

## Documentation corrections made along the way

- `architecture.md`'s original "Delivery inspection" row cited fields (`responseDurationMs`, `triggerType`) from the third-party write-up that don't appear in the real endpoint's response. Replaced with the confirmed field list from `GET /webhooks/{webhookId}/events`.
- Added the `PATCH /webhooks/{webhookId}` update endpoint (not previously documented in this project).
- Corrected the retry endpoint's path parameter name (`deliveryId`, not `eventId` as the implementation plan's placeholder had assumed).
- Added the malformed-JSON-after-valid-signature case to the failure-modes table (section 7) — it was implemented and tested in Phase 2 but the table didn't mention it yet.
- Flagged a naming risk: the `deliveries.webhook_id` SQLite column stores the payload's `id` (`eventId`), not the HTTP `webhook-id` header — same name, different concept. Noted as a follow-up rename to consider, not fixed immediately (would be unnecessary churn mid-phase).

## Acceptance

- 14/14 tests passing (10 from Phase 1 + 4 new), `tsc --noEmit` and `eslint .` both clean.
- Live round-trip confirmed against real Quo infrastructure, not just in-process tests.
- E1 run and recorded — the hard gate for this phase — before moving on.
- Tunnel and dev server both torn down after live testing.

## Artifacts

- `src/app.ts`, `src/arrivalLog.ts`, `src/db/DeliveryStore.ts`, `src/db/sqliteDeliveryStore.ts`, `src/server.ts`, `src/testSupport/sign.ts`, `src/app.test.ts`
- `architecture.md` updates: new Documented rows (update endpoint, delivery inspection, id/eventId distinction, E1 result), D2 finalized in section 6, failure-modes table addition, section 4.1 corrections.
- Not committed as of this summary.

---

**Next:** Phase 3, worker and handlers — builds on the now-confirmed D2 dedupe key and the `DeliveryStore` interface, extending it with lease-based claims (D9).
