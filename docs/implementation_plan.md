# Quo Webhook Lab: Implementation Plan

Companion to `architecture.md`. Last updated 2026-10-27, updated for decisions D1 to D10. Estimates assume focused evenings or weekends and total roughly 20 to 28 hours for the core lab (Phases 0 to 5), with Phase 6 optional.

## 0. Plan
**Suggested project name:** Quo Webhook Lab

**Knowledge files to upload:** `architecture.md`, this file, and later the findings doc and any code you want reviewed.

**Suggested project instructions (paste into the project):**
> I am building the Quo Webhook Lab described in the knowledge files, in Node/TypeScript. Treat `architecture.md` as the source of truth for design and this plan for sequencing. The decisions in architecture section 6 (D1 to D10) are settled; reopen one only when an experiment contradicts it. Work one phase at a time. Before writing code for a phase, restate the acceptance criteria. Keep the documented-versus-unknown distinction for Quo behavior: never state an unknown as fact, and flag when a result contradicts the docs. Prefer small, testable steps and tests first. I want to understand each piece, so explain trade-offs briefly and ask me questions where I should make the call. Remind me to redact personal data in anything I paste.

**Suggested first prompts, one per phase:**
1. "Walk me through Phase 0 and help me create the Quo test workspace and webhook subscription."
2. "Let's do Phase 1. Write the failing tests for signature verification first."
3. "Review my Phase 2 ingest route against the failure-modes table."
Keep a running `decisions.md` in the project and update it when a result changes the design.

## 1. Guiding principles
- **Measure before assuming.** The core dedupe assumption (`webhook-id` is stable across retries) is verified first, in Phase 2.
- **Tests first for the dangerous parts** (verification, dedupe, ordering, worker backoff).
- **Receiver-side data is the ground truth** for retry timing. Quo's per-attempt detail is a cross-check.
- **Real accounts are sensitive.** Personal test workspace only; no customer data; redact logs.
- **Ship small and publicly.** A clean repo plus a short findings write-up beats a large unfinished system.

### Settled design decisions (from architecture section 6)
- **D1** Acknowledge fast, process in the background.
- **D2** Dedupe on `webhook-id`, pending E1; fall back to a hybrid payload-derived key if the id changes.
- **D3** SQLite outbox behind a small storage interface.
- **D4** Verify the raw bytes before parsing.
- **D5** Return 401 on a bad signature, pending E5.
- **D6** Svix for verification now; a hand-rolled version later as a learning exercise.
- **D7** Express (not Fastify).
- **D8** No `arrivals` table at first; one structured log line per arrival.
- **D9** Lease-based worker claims; choose the lease duration in Phase 3.
- **D10** Stale-event guard on upserts; confirm the event timestamp field in Phase 0.

## 2. Phases

### Phase 0: Environment and ground truth (2 to 3 h)
**Tasks**
- [ ] Create or use a personal Quo workspace with a test phone number. Confirm webhook API access and generate an API key.
- [ ] Install Node 22, cloudflared (or ngrok), sqlite3 CLI.
- [ ] Create the repo (`quo-webhook-lab`), TypeScript strict config, Vitest, ESLint/Prettier, `.env.example`, `.gitignore` (data/, .env).
- [ ] Create a beta webhook subscription (`POST /webhooks`, pinned API version) pointing at a tunnel URL; save the `whsec_` secret.
- [ ] Fire a test event (`POST /webhooks/:id/events/test`) and capture one raw request (headers and body) to a fixtures folder, with personal data redacted.

**Acceptance:** you hold one real captured delivery and know the actual header names, timestamp unit and payload shape. Update `architecture.md` section 2 "Unknown" items that this resolves (payload shape, timestamp unit, API version header name), and confirm which payload field carries the event time for the D10 stale-event guard.

### Phase 1: Signature verification (2 to 3 h)
**Tasks**
- [ ] `verifyQuoSignature(rawBody, headers, secret)` using Svix (D6).
- [ ] Follow-up, can wait: a small hand-rolled HMAC check as a learning exercise, tested against the same fixtures.
- [ ] Tests: valid signature; tampered body; wrong secret; missing headers; stale timestamp; future timestamp; multiple signatures in the header (after rotation).
- [ ] Verify the captured real delivery from Phase 0 passes.

**Acceptance:** all tests green, and the real captured request verifies. No parsing of JSON happens before verification.

### Phase 2: Ingest, arrival log and dedupe (3 to 4 h)
**Tasks**
- [ ] SQLite setup and schema (`deliveries` and the domain tables) behind a small storage interface (D3). No `arrivals` table yet (D8).
- [ ] Express route with `express.raw()` mounted on the webhook route only, before any JSON parser (D4, D7); verify, write one structured log line per arrival (webhook id, event type, timestamp, outcome), insert with `ON CONFLICT DO NOTHING`, respond 200.
- [ ] Tests (using supertest against the Express app with locally signed requests): accepted; duplicate returns 200 with one row and two logged arrivals; bad signature returns 401 and stores nothing; malformed JSON after valid signature.
- [ ] Run against live Quo with the tunnel. Send several test events.
- [ ] **Experiment E1 (stability of `webhook-id`).** Use manual retry for one delivery and confirm the retried delivery carries the same `webhook-id`.

**Acceptance:** E1 result recorded. If `webhook-id` is not stable, stop and redesign dedupe (for example on a payload event id) before continuing. This is the project's biggest early risk.

### Phase 3: Worker and handlers (4 to 5 h)
**Tasks**
- [ ] Worker loop with lease-based claims, exponential backoff with jitter, `maxAttempts`, `dead` state. Injectable clock and random source for tests. Choose the lease duration here (D9); a crash during processing counts as an attempt.
- [ ] Handlers for `call.completed`, `call.summary.completed`, `message.received` with upserts and the stale-event guard.
- [ ] Tests: success path; handler throws then succeeds on retry; poison event reaches `dead`; simulated crash (lease expiry) reclaims the row; out-of-order summary-before-call yields a correct joined read; stale event does not overwrite newer data.
- [ ] `/healthz`, `/debug/deliveries`, `/debug/stats`, structured logging without payloads.

**Acceptance:** each row in the architecture failure-modes table that concerns processing has a passing test.

### Phase 4: Fault injection and the retry experiments (4 to 6 h)
**Tasks**
- [ ] Implement `FAULT_MODE` (`fail_first:N`, `slow:MS`).
- [ ] Promote the arrival log lines to an `arrivals` table if the analysis needs queryable data (D8).
- [ ] Analyzer CLI: per-delivery arrival times, gaps, attempt counts, aggregate tables, export to CSV.
- [ ] Run the experiments below, one at a time, with fresh test events. Save raw `arrivals` exports into `data/experiments/`.

| ID | Question | Method | Record |
|---|---|---|---|
| E1 | Is `webhook-id` stable across retries? | Manual retry of a delivered event | ids of both attempts |
| E2 | What is the automatic retry schedule and attempt limit? | `fail_first:100` (always 500) | arrival gaps until Quo stops; total attempts |
| E3 | What is the delivery timeout? | `slow:MS` for several values (for example 2s, 5s, 10s, 30s) | whether Quo retries; response duration shown in Quo's attempt detail |
| E4 | Which status codes are retried? | Respond 400, 401, 404, 410, 429, 500, 503, and a 3xx in turn | retry or no retry per code |
| E5 | What happens with a bad signature or after secret rotation? | Wrong secret in config; then rotate via the API | retries or not; recovery procedure |
| E6 | Does repeated failure disable the subscription? | Keep failing across several events | subscription `status` over time |
| E7 | Are events ordered? | Trigger a call that produces several events quickly | arrival order versus event timestamps |
| E8 | Does reconciliation recover an outage? | Stop the receiver, generate events, restart, run reconciler | events recovered, duplicates absorbed |

**Acceptance:** each experiment has a one-paragraph result and raw data. Where results contradict the docs, flag them clearly.

### Phase 5: Reconciler and write-up (3 to 4 h)
**Tasks**
- [ ] Quo API client (list deliveries paged, get detail, retry, test event) with both version header spellings sent until E-results settle which is correct.
- [ ] Reconciler: dry-run by default, `--apply` to retry; pacing; tests with a mocked client.
- [ ] README: what it is, architecture diagram, quick start, how to run each experiment safely.
- [ ] `FINDINGS.md`: measured retry behavior with tables and caveats (beta API, date measured, API version `2026-03-30`).
- [ ] Clean repo hygiene: no secrets or personal data in history, MIT license, CI running typecheck and tests.

**Acceptance:** a stranger can clone, run tests and reproduce at least E1 and E2 from the README.

### Phase 6 (optional): Temporal variant and outreach (4 to 6 h)
**Tasks**
- [ ] Temporal dev server locally; workflow per delivery with `webhook-id` as workflow id; activity with a retry policy.
- [ ] Comparison write-up: lines of code, behavior under E2/E3-style failures, operational trade-offs.
- [ ] Decide how to share (see section 5).

## 3. Test strategy
- **Unit:** verification, backoff math, upsert guards.
- **Integration (in-process):** supertest against the Express app with real SQLite (in-memory) covering ingest plus worker.
- **Contract (manual, live):** the experiments, using a real Quo workspace.
- **Deterministic time:** inject clock and random so backoff tests need no sleeping.
- **CI:** typecheck, lint, tests on every push; no live API calls in CI.

## 4. Risks and mitigations
| Risk | Likelihood | Mitigation |
|---|---|---|
| `webhook-id` not stable across retries | Medium | E1 early in Phase 2; fall back to a payload event id |
| Beta API changes mid-project | Medium | Pin `2026-03-30`; date-stamp findings |
| Need a paid or specific plan for webhook or API access | Unknown | Confirm in Phase 0 before investing further |
| Test events do not mirror real event payloads | Medium | Also trigger real events from your own test number |
| Accidentally logging personal data | Medium | No-payload logging, redacted fixtures, review before every push |
| Scope creep into a full product | High | Phase gates; the optional phase only after write-up |
| Experiments cost real credits (messages) | Low to medium | Prefer call and test events; check pricing before message-sending tests |

## 5. Sharing it responsibly
- Publish the repo and findings on your own GitHub; this is your work on a public, documented API.
- If you want Quo's team to see it, a short note to the recruiter or hiring manager with the repo link and a three-line summary of findings is enough. Avoid posting it as a PR or issue on their repos unless they invite it.
- Be accurate about status: findings come from the beta API at a point in time. Do not present measured behavior as a guarantee.
- Do not publish anything that implies insider knowledge or includes private workspace data.

## 6. Interview talking points this produces
- Why ack-then-process, and what at-least-once delivery forces on handler design.
- Dedupe keys: where they come from, what happens if they are unstable.
- Evidence-based reliability work: you measured retry behavior instead of guessing.
- Trade-offs: SQLite outbox versus Postgres or a broker versus Temporal.
- Failure-mode thinking: out-of-order events, poison messages, crash recovery, secret rotation.

## 7. Open questions to resolve early
1. Does your Quo plan include API and webhook access, and what are the limits?
2. Does Quo document the retry policy anywhere not yet found (support site, changelog)?
3. Which event types do you want as the main demo: calls plus summaries (richest for ordering) or messages (simplest)?
4. Hosting for the demo: local plus tunnel only, or a small deployed instance?
5. Optional: which web framework does Quo's team use? (D7 is settled as Express either way.)
6. Does this build cover the webhook lab only, or also an inbound image pipeline? The domain tables would differ.

## 8. Definition of done
- [ ] Tests pass locally and in CI.
- [ ] E1 to E4 and E8 completed with raw data; E5 to E7 completed or explicitly skipped with reasons.
- [ ] `FINDINGS.md` published with dates and caveats.
- [ ] README lets a stranger reproduce E1 and E2.
- [ ] No secrets or personal data in the repository history.
