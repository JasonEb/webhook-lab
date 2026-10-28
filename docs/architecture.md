# Quo Webhook Lab: Architecture

A Node/TypeScript webhook receiver built to survive retries, plus tooling to measure how Quo's webhook delivery actually behaves. Last updated 2026-10-27. Design decisions D1 to D10 are settled and recorded in section 6.

## 1. Purpose and success criteria

**Purpose.** Build a small, production-shaped receiver for Quo's beta webhooks and use it to empirically study retry behavior. The result is a public repo and a short findings write-up.

**Why this project.** It targets reliability engineering (retries, idempotency, failure recovery) on a real, current Quo API, in Quo's own stack (TypeScript/Node). It also gives a concrete bridge toward Temporal-style durable execution.

**Success criteria**
1. Every valid delivery is processed exactly once in effect, even when delivered several times.
2. Forged, tampered and replayed requests are rejected.
3. A receiver outage loses no events (recovered via reconciliation).
4. Slow or crashing handlers never cause lost events or duplicate side effects.
5. A written findings doc reports measured retry behavior (schedule, attempt count, timeouts, status-code sensitivity) with raw data.

**Non-goals.** Multi-tenant SaaS, a UI, horizontal scaling, supporting the legacy `openphone-signature` scheme beyond a documented note.

## 2. What we know about Quo's beta webhooks

Source: Quo beta webhook docs and a third-party skill write-up (see Sources).

### Documented (treat as facts, still verify in experiments)
| Topic | Detail |
|---|---|
| Subscription | `POST /webhooks` with `events`, `url`, optional `label`, optional `resourceIds` (phone number **IDs** matching `^PN`, not raw numbers; `["*"]` or omitted = all), optional `status` (`enabled`\|`disabled`, default `enabled`). API version is pinned per subscription at creation. Response wraps the object in `data`; the signing secret is returned as `data.key` (a `whsec_...` value). Source: https://www.quo.com/docs/2026-03-30/webhooks/create-a-new-webhook |
| API version header | `Quo-Api-Version: 2026-03-30` is the header the API reference documents as required. No mention of `x-quo-api-version` in the reference for `POST /webhooks`. |
| Signing | Standard Webhooks style: `webhook-id`, `webhook-timestamp`, `webhook-signature`. Quo also sends duplicate `svix-id`/`svix-timestamp`/`svix-signature` headers with identical values, and a `webhook-test: true` header on test-triggered deliveries. Secret is `whsec_...` base64, compatible with the Svix SDK. `webhook-timestamp` is **seconds** (10-digit Unix epoch), not milliseconds. Confirmed 2026-10-27 via `fixtures/sample-delivery.json`. |
| Payload shape (beta) | `{ id, type, apiVersion, createdAt, data: { resource: {...}, context: { conversationId, orgId, phoneNumberId, phoneNumberType, userId, contacts, participants } } }`. Beta uses `data.resource`; legacy uses `data.object` — the two are structurally different, not just renamed. Confirmed 2026-10-27 via `fixtures/sample-delivery.json` (a synthetic test event, so field presence is confirmed but real-event values are not). |
| Event timestamp (D10) | **Top-level `createdAt` and `data.resource.createdAt` are different things and are not interchangeable.** Top-level `createdAt` is when Quo generated the *webhook event*; `data.resource.createdAt` (or `.completedAt` for a terminal call state) is when the *domain event itself* happened. The D10 stale-event guard must compare on the `data.resource.*` timestamp — using the top-level one would make retries of the same event look like newer events. Confirmed 2026-10-27 via a real (non-test) `message.received` delivery, `fixtures/sample-message-delivery.json` (211ms gap observed between the two timestamps on one message). **Per-event-type fields, all confirmed 2026-10-27 via a real call (Phase 3):** `message.received` → `data.resource.createdAt`. `call.completed` → `data.resource.completedAt` (field set matches the synthetic test payload exactly: `answeredAt`/`completedAt`/`createdAt`/`direction`/`duration`/`hasVoicemail`/`id`/`status`/`updatedAt`). `call.summary.completed` → **no resource-level timestamp exists at all** (real fields: `answeredByUserId`/`callId`/`fromPhoneNumber`/`handledByAiAgent`/`nextSteps`/`processingStatus`/`summary`) — this is a genuine exception to the "always use `data.resource.*`" rule above, not a violation of it: the handler falls back to the top-level `createdAt` for this one event type specifically, since there's no better signal available. Also confirms `data.resource.callId` is the correct field linking a summary back to its call. |
| Raw body | Verification needs the exact raw bytes of the request body. |
| Test events | `POST /webhooks/:id/events/test` with `{ "eventType": ... }`. Test deliveries always get `eventId: null` and a fixed canned payload (same `id`/resource values every time) — not useful for E1-style experiments that need a real event. |
| Update a webhook | `PATCH /webhooks/{webhookId}`, partial update, any of `url`/`events`/`resourceIds`/`status`/`label`. Confirmed working 2026-10-27 (used to repoint a subscription at a new tunnel URL without recreating it). Source: https://www.quo.com/docs/2026-03-30/webhooks/update-a-webhook-by-id.md |
| Delivery inspection | `GET /webhooks/{webhookId}/events`. Confirmed fields (2026-10-27, superseding the earlier third-party-sourced guess of `responseDurationMs`/`triggerType`, which do not appear): `id` (delivery id, equals the `webhook-id`/`svix-id` HTTP header — confirmed by direct comparison), `eventId` (the payload body's own top-level `id` field; `null` for test deliveries and deliveries before 2026-09-01), `resourceId`, `eventType`, `status` (`success`\|`pending`\|`sending`\|`failed`), `nextAttemptAt`, `createdAt`. Source: https://www.quo.com/docs/2026-03-30/webhook-events/list-deliveries-for-a-webhook.md |
| Delivery `id` vs payload `id` (`eventId`) | **These are two different identifiers and must not be conflated.** The delivery's `id` (= `webhook-id` header) identifies the dispatch; the payload body's own `id` field (called `eventId` in the delivery-list API) identifies the underlying business event. They happened to be equal in no capture so far — they're independent values. See the E1 row below for which one is actually stable across retries (both, as it turns out, but for a manual retry specifically). |
| Manual retry | `POST /webhooks/{webhookId}/events/{deliveryId}/retry`, where `deliveryId` is the delivery's `id` (not the payload `eventId`). Returns `202 Accepted`, runs asynchronously. Source: https://www.quo.com/docs/2026-03-30/webhook-events/retry-a-webhook-delivery.md |
| E1: webhook-id stability across retries | **Confirmed stable**, 2026-10-27. Triggered a manual retry of a real `message.received` delivery and compared both identifiers before/after: the delivery's `id` (`webhook-id`/`svix-id` header) and the payload's `id` (`eventId`) were both identical across the retry — Quo re-dispatches the same delivery rather than creating a new one, confirmed via the `webhook-id` header on the actual re-received HTTP request (not just the delivery-list API). D2's dedupe-on-payload-`id` approach is confirmed correct, and would also have worked keyed on the header. **Caveat:** this tested a *manual* retry only (via the retry API). Automatic retries (after our server fails/times out) are expected to behave the same way but haven't been directly observed yet — will be re-confirmed naturally during Phase 4's fault-injection experiments (E2). |
| Secret rotation | `POST /webhooks/:id/rotate` returns a new `whsec_` key. |
| Events | message.*, call.*, contact.*, task.*, integration.* (see API reference for the full list). |
| Migration | Legacy and beta signature schemes are not interchangeable. Quo's migration guide says to dedupe beta retries. |
| Failure mode | Confirmed directly (Phase 4, E4/E5), superseding the third-party write-up's narrower "500 triggers a retry" claim: **every tested non-2xx response retries** — 400, 401, 429, 500, 503 all retried once, with consistent ~5.1–5.2s timing regardless of code. Not special-cased by error category (client vs. server, auth vs. other). |

### Unknown (remaining after Phase 4's experiments, 2026-10-28)
- **Maximum retry attempts / full backoff schedule.** E2 observed 4 attempts over ~39 minutes with growing (not clean-doubling) gaps — 4.2s, 5m37s, 32m54s — then observation stopped by scope decision, not because retries were confirmed to stop. The ceiling is still unknown.
- **Exact delivery timeout value.** E3 bounded it to "greater than 10s, at or before 30s" — not pinned to a precise number (15s/20s weren't tested).
- Whether a redirect (3xx) is retried — not tested (E4 was trimmed to 400/429/500/503; see `plan_deviations.md` V10).
- Whether repeated failure *eventually* auto-disables a subscription over a long window — E6 only covered ~90s/3 events and found no change; a multi-hour test was explicitly not run.
- Whether *independent* (non-causally-related) events can ever arrive out of order — E7's one trial only tested a causally-dependent pair (`call.completed`→`call.summary.completed`), which is a weaker test than independent events racing each other.

### Resolved by Phase 4's experiments (see `data/experiments/README.md` for full write-ups and raw data)
- **E2 — retry schedule:** confirmed growing backoff (not available anywhere in Quo's docs beforehand). Not clean exponential doubling.
- **E3 — delivery timeout:** no retry at 2s/5s/10s delay; retry observed at 30s delay. Bounds the timeout to (10s, 30s].
- **E4 — which status codes retry:** all of 400, 429, 500, 503 retried, with consistent ~5.1–5.2s timing regardless of code. **Notable: 4xx client errors are retried exactly like 5xx server errors** — Quo does not appear to treat them specially, which differs from common webhook-provider convention.
- **E5 — bad signature / rotation:** a 401 retries exactly once (~5.2s later), same timing as E4's codes — no special-casing. `POST /webhooks/{id}/rotate` + updating the receiver's secret restores normal processing immediately, no propagation delay.
- **E6 — repeated failure / subscription status:** no auto-disable observed within the tested window (bounded negative result, not proof it never happens).
- **E7 — ordering:** one real call's `call.completed`/`call.summary.completed` pair arrived in causal order, consistent with both events' own timestamps. Single trial of a dependent pair, not a general ordering guarantee.

## 3. System overview

```
                       ┌──────────────────────────────────────────────┐
                       │                 Quo (cloud)                  │
                       │  event ──> delivery attempts (retries)       │
                       │  API: list deliveries / retry / test event   │
                       └───────┬───────────────────────────▲──────────┘
        HTTPS POST (signed)    │                           │ REST (API key)
                               ▼                           │
                      tunnel (cloudflared/ngrok)           │
                               │                           │
┌──────────────────────────────▼───────────────────────────┴──────────┐
│                      quo-webhook-lab (one Node process)             │
│                                                                      │
│  ┌─────────────── HTTP path (must be fast) ───────────────┐          │
│  │ Express route POST /webhooks/quo                        │          │
│  │  1 raw body buffer                                      │          │
│  │  2 verify signature (Svix, 5 min tolerance)  ──401──>   │          │
│  │  3 log arrival (every attempt, incl. duplicates)        │          │
│  │  4 fault injector (experiments only)         ──5xx/slow>│          │
│  │  5 INSERT delivery ON CONFLICT DO NOTHING (dedupe)      │          │
│  │  6 respond 200                                          │          │
│  └──────────────┬──────────────────────────────────────────┘          │
│                 ▼                                                     │
│        ┌──────────────────┐   claim lease    ┌──────────────────┐     │
│        │  SQLite (WAL)    │ <──────────────  │  Worker loop     │     │
│        │  deliveries      │  mark done /     │  backoff + jitter│     │
│        │  arrivals        │  retry / dead    │  per-event type  │     │
│        │  calls/summaries │ ───────────────> │  handlers        │     │
│        │  messages        │                  └──────────────────┘     │
│        └───────▲──────────┘                                           │
│                │                                                      │
│   ┌────────────┴─────────┐        ┌──────────────────────────┐        │
│   │ Reconciler (CLI/cron)│        │ Analyzer (CLI)           │        │
│   │ diff Quo deliveries  │        │ arrivals → retry gaps,   │        │
│   │ vs local, retry gaps │        │ attempt counts, timings  │        │
│   └──────────────────────┘        └──────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
```

Three independent paths share one database:
1. **Ingest path** (synchronous, milliseconds): verify, record, dedupe, acknowledge.
2. **Processing path** (asynchronous): a worker applies business effects with its own retries.
3. **Recovery and measurement paths** (on demand): the reconciler heals gaps and the analyzer turns raw arrivals into findings.

## 4. Components

### 4.1 Ingest (Express route)
- Mounts `express.raw({ type: 'application/json' })` on the webhook route only, before any JSON parser, so the handler receives the raw `Buffer` unchanged. No other middleware may touch the body. Parsing happens only after verification. Implemented in `src/app.ts` (Phase 2).
- Verifies with the Svix `Webhook` class using the three headers and the raw body. Rejects with **401** on missing headers, bad signature or stale timestamp. A signature failure is logged separately (not via the `arrival` log — see next bullet), since the body isn't parsed yet and `event_type` isn't known at that point.
- Records every verified arrival with an outcome (`accepted`, `duplicate`, `faulted`). Initially this is one structured log line per arrival (webhook id, event type, timestamp, outcome); the `arrivals` table is deferred (D8). `faulted` is reserved for the Phase 4 fault injector; a signature failure or a malformed-JSON parse failure are logged via a separate rejection line instead of stretching this enum to a value the docs don't define.
- Inserts into `deliveries` keyed by the payload body's own `id` field (**not** the `webhook-id` HTTP header — they're different identifiers, see section 2) using `ON CONFLICT DO NOTHING`. A duplicate returns **200**, because from Quo's perspective the event was received. Confirmed stable across retries via E1.
- Does no business logic. Anything slow or fallible belongs to the worker.

### 4.2 Worker
- Polls for rows where `status = 'pending'`, `next_run_at <= now` and the lease has expired.
- Claims a row by setting `locked_until` inside a transaction (a lease, so a crashed worker's rows are reclaimed automatically).
- Dispatches to a handler by event type. Success sets `done`. Failure increments `attempts` and schedules `next_run_at` with exponential backoff and jitter. After `maxAttempts` the row becomes `dead` and stays inspectable.
- Handlers must be **idempotent** (see 4.3), because the worker gives at-least-once execution.

### 4.3 Handlers and domain tables
- Upserts keyed by the resource id (`calls`, `summaries`, `messages`).
- A staleness guard on `event_at` (`... WHERE excluded.event_at >= existing.event_at`) so an old event arriving late never overwrites newer data.
- Order independence: `call.summary.completed` can arrive before `call.completed`. The summary is stored by `call_id` with no foreign key, and reads join the two tables.

### 4.4 Fault injector (experiments only)
Configured by `FAULT_MODE`: `none`, `fail_first:N` (500 to the first N arrivals of each `webhook-id`), `slow:MS`. It sits after verification and arrival logging so faulted attempts are still measured. It is disabled by default and must never be enabled in a real deployment.

### 4.5 Reconciler
- Calls Quo's list-deliveries endpoint (paged), compares with local `deliveries`, and calls the retry endpoint for deliveries that failed on Quo's side and are missing locally.
- Dedupe makes it safe to retry something we may already have.
- Dry-run mode by default for destructive-looking actions; polite request pacing.

### 4.6 Analyzer
- Reads the arrival record (log lines first, the `arrivals` table once promoted) and prints, per `webhook-id`, arrival timestamps and inter-arrival gaps, then aggregates attempt counts and gap distributions per fault scenario.
- Receiver-side measurement is the primary data source because it does not depend on API response shapes. Quo's per-attempt detail is the cross-check.

## 5. Data model

```
deliveries(webhook_id PK, event_type, payload, received_at,
           status [pending|done|dead], attempts, next_run_at,
           locked_until, last_error)
arrivals(id PK, webhook_id, event_type, received_at, ts_header,
         outcome [accepted|duplicate|faulted])
calls(id PK, data, event_at)
summaries(call_id PK, data, event_at)
messages(id PK, data, event_at)
```

> **Deferred (D8).** The `arrivals` table above is not built first. Phase 2 writes one structured log line per arrival instead, which is enough to run E1. Promote it to the table once the retry experiments need queryable data.

Indexes: `deliveries(status, next_run_at)` for the worker poll, `arrivals(webhook_id, received_at)` for analysis.

## 6. Key design decisions

Each row shows the recommendation next to the final decision. **The final decision column is the one that counts.** Rows marked DIFFERS are where the final decision differs from the recommendation.

| # | Decision | Recommended | Final decision | Status | Rationale and trade-off |
|---|---|---|---|---|---|
| D1 | When to respond to Quo | Acknowledge fast, process in the background | Same (A). Verify, save, return 200, and let a worker do the real work. | Final | Keeps response time far under any delivery timeout, so slow handlers do not trigger retries. Needs a durable queue (the outbox in D3). |
| D2 | Dedupe key | Unique key on `webhook-id` | **Dedupe on the payload body's top-level `id` field** (what Quo's delivery-list API calls `eventId`), not the `webhook-id` HTTP header — they are two different identifiers (see architecture.md section 2). Confirmed stable across a manual retry via E1; both identifiers were in fact stable in that test, so either would have worked, but the payload field is used since it's what the handler already has in hand after parsing, with no header-lookup indirection. Implemented in `src/app.ts`/`src/db/sqliteDeliveryStore.ts` (Phase 2). | **Final, E1 confirmed** | Simple and atomic (`INSERT ... ON CONFLICT DO NOTHING`, `deliveries.webhook_id` column — the column name predates this finding and refers to the payload id, not the header; worth a rename if it causes confusion later). E1 confirmed stability for a manual retry; automatic-retry stability will be re-confirmed in Phase 4 (E2) rather than assumed. |
| D3 | Outbox storage | SQLite | Same. SQLite, with storage code behind a small interface so a Postgres swap stays contained. | Final | Zero infrastructure, transactional, inspectable with `sqlite3`. Single node only; production would use Postgres or a queue. |
| D4 | Signature check order | Verify raw bytes before parsing | Same. | Final | Required by the signature scheme and blocks tampering. Any middleware that touches the body first breaks every valid request. |
| D5 | Response to a bad signature | 401 | Same. Return 401, do no work, store nothing. | Pending E5 | Honest signal that surfaces a misconfigured secret. Whether Quo retries a 401 is unknown and is measured in E5. |
| D6 | Verification method | Svix library | Svix in the main code. Follow-up: write a small hand-rolled version later as a learning exercise. | Final | Well-tested; handles timestamp tolerance, safe comparison and multiple signatures during rotation. Adds one dependency. |
| D7 | Web framework (DIFFERS) | Fastify | **Express.** | Final | Express is the most widely recognized. Keeping the raw body needs about five to ten lines (D4) and its typing is looser. Fastify would have made raw-body access and TypeScript types easier. |
| D8 | Arrival record (DIFFERS) | An `arrivals` table from the start | Defer the table. Write one structured log line per arrival (webhook id, event type, timestamp, outcome) now, and promote it to a table later. | Final, table deferred | Receiver-side data is the ground truth for retry timing. The log line is enough to answer E1. It only sees attempts that reach us, so Quo's delivery detail is the cross-check. |
| D9 | Worker claims | Lease-based | Same (A). A crash during processing counts as an attempt when the row is reclaimed, so repeated crashes end in `dead` after `maxAttempts`. | Final, lease duration open | Crash recovery without a separate reaper. Slightly more complex than a status flag, and the lease length must be chosen when the worker is built. |
| D10 | Stale-event guard on upserts | Add the guard | Same (A). A write lands only if the incoming `event_at` is newer than or equal to the stored one. Per-event-type timestamp field confirmed for all three event types (section 2) — `call.summary.completed` is a documented exception using top-level `createdAt`, since its resource carries no timestamp of its own. Implemented in `src/handlers/index.ts`/`src/db/domainStore.ts` (Phase 3). | **Final, timestamp fields confirmed** | Handles out-of-order delivery and late retries. |

### Follow-ups from these decisions
- ~~Run E1 early to confirm whether `webhook-id` is stable across retries (D2)~~ — done, confirmed stable (Phase 2, 2026-10-27). ~~Check the event timestamp field in the first real payload (D10)~~ — done for all three event types (Phase 3, 2026-10-27).
- Consider renaming the `deliveries.webhook_id` column to something like `event_id` to avoid confusion with the actual `webhook-id` HTTP header, which is a different value (see section 2).
- Measure how Quo reacts to a 401 (D5, E5).
- Promote the structured arrival log to an `arrivals` table when the experiments need it (D8).
- Write a small hand-rolled signature check as a learning exercise (D6).
- Choose the worker lease duration when building the worker (D9).
- Optional: check which framework Quo's engineers use (D7).
- Decide whether these decisions apply to the webhook lab, an inbound image pipeline, or both. The domain tables would differ.

## 7. Failure modes and responses

| Failure | Behavior |
|---|---|
| Duplicate delivery | Unique key makes the insert a no-op; returns 200; arrival logged as `duplicate` |
| Out-of-order events | Order-independent upserts plus stale guard |
| Receiver down or 5xx | Quo retries (schedule measured in E2); reconciler fills any gap afterwards |
| Slow response | Ingest does no heavy work; `slow:MS` mode measures Quo's timeout (E3) |
| Handler throws | Worker retries with backoff; ingest already returned 200 so Quo does not retry |
| Poison event | Reaches `dead` after `maxAttempts`; stays queryable; does not block the queue |
| Crash mid-processing | Lease expires; row is reclaimed; handler idempotency makes re-execution safe |
| Forged or tampered body | Signature check fails, 401, nothing stored |
| Validly signed but malformed JSON | Signature passes (it only covers raw bytes, not JSON validity), parsing fails, 400, nothing stored. Rejection logged separately from the `arrival` log, not as a fourth outcome value (see 4.1). Implemented and tested in Phase 2. |
| Replayed capture | Timestamp tolerance rejects it; dedupe blocks in-window replays |
| Secret rotation | Verification fails after rotation until config is updated; test in E5 and document the procedure |
| Clock skew | Timestamp tolerance rejects valid requests if our clock drifts; run NTP, log rejections |

## 8. Security and data handling
- Secrets (`QUO_WEBHOOK_SECRET`, `QUO_API_KEY`) live in environment variables only and are never logged or committed.
- Quo payloads contain phone numbers and message text (personal data). Use a **personal test workspace and test numbers**, never a real customer's account. Redact payloads in logs; store payloads only in the local database.
- Use HTTPS for any non-local URL. Tunnel URLs are temporary and should be deleted after experiments.
- Fault injection is off by default and clearly labeled.
- Do not add the receiver to any account you do not own.

## 9. Observability
- Structured JSON logs with `webhook_id`, `event_type`, `outcome`, `attempt`, `duration_ms`. No payload bodies.
- Counters (simple in-process, exposed at `/debug/stats`): arrivals by outcome, deliveries by status, handler failures, dead rows.
- `/healthz` and `/debug/deliveries` for quick inspection during experiments.

## 10. Extension: Temporal variant
Replace the worker and outbox with a Temporal workflow started by ingest, using `webhook-id` as the **workflow id** (Temporal's id-uniqueness then provides the dedupe). Activities carry retry policies, so backoff moves from our code into configuration. A comparison table (code size, failure handling, observability, operational cost) is the second deliverable and a strong interview talking point. This is optional and only starts after the core lab and findings are done.

## 11. Technology stack
Node 22, TypeScript (strict), Express (with `@types/express`), better-sqlite3, Svix (verification), Vitest, tsx. Tunnel: cloudflared or ngrok.

## 12. Sources
- Quo beta webhooks quickstart: https://www.quo.com/docs/mdx/beta/webhooks-quickstart
- Quo beta webhooks API reference: https://www.quo.com/docs/mdx/beta/webhooks-api-reference
- Differences from current webhooks: https://www.quo.com/docs/mdx/beta/webhooks-differences-from-current
- Legacy webhook docs: https://support.openphone.com/core-concepts/integrations/webhooks
- Third-party skill write-up (Hookdeck): https://hookdeck.com/webhooks/skills/quo-webhooks
- Standard Webhooks specification: https://www.standardwebhooks.com
