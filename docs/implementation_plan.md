# Quo Webhook Lab: Implementation Plan

Companion to `architecture.md`. Last updated 2026-10-27, updated for decisions D1 to D10. Estimates assume focused evenings or weekends and total roughly 20 to 28 hours for the core lab (Phases 0 to 5), with Phase 6 optional.

## 0. Plan
**Suggested project name:** Quo Webhook Lab

**Knowledge files to upload:** `architecture.md`, this file, `phase_0_implementation_plan.md` through `phase_4_implementation_plan.md` and their matching `phase_N_summary.md` files, `bug_log.md`, `plan_deviations.md`, and later the findings doc and any code you want reviewed.

**Suggested project instructions (paste into the project):**
> I am building the Quo Webhook Lab described in the knowledge files, in Node/TypeScript. Treat `architecture.md` as the source of truth for design and this plan for sequencing. The decisions in architecture section 6 (D1 to D10) are settled; reopen one only when an experiment contradicts it. Work one phase at a time. Before writing code for a phase, restate the acceptance criteria. Keep the documented-versus-unknown distinction for Quo behavior: never state an unknown as fact, and flag when a result contradicts the docs. Prefer small, testable steps and tests first. I want to understand each piece, so explain trade-offs briefly and ask me questions where I should make the call. Remind me to redact personal data in anything I paste.

**Suggested first prompts, one per phase:**
1. "Walk me through Phase 0 and help me create the Quo test workspace and webhook subscription."
2. "Let's do Phase 1. Write the failing tests for signature verification first."
3. "Review my Phase 2 ingest route against the failure-modes table."
Keep a running `decisions.md` in the project and update it when a result changes the design. **In practice this became three files, not one:** `architecture.md` section 2/6 for resolved facts and decisions, `bug_log.md` for defects found and fixed, and `plan_deviations.md` for places this plan's own assumptions turned out wrong. Each phase also has a `phase_N_implementation_plan.md` (detailed steps, written before executing) and a `phase_N_summary.md` (what actually happened, written after) — this file stays the high-level sequencing reference; the granular ones are where the detail and the history live.

## 1. Guiding principles
- **Measure before assuming.** The core dedupe assumption (`webhook-id` is stable across retries) is verified first, in Phase 2.
- **Tests first for the dangerous parts** (verification, dedupe, ordering, worker backoff).
- **Receiver-side data is the ground truth** for retry timing. Quo's per-attempt detail is a cross-check.
- **Real accounts are sensitive.** Personal test workspace only; no customer data; redact logs.
- **Ship small and publicly.** A clean repo plus a short findings write-up beats a large unfinished system.

### Settled design decisions (from architecture section 6)
- **D1** Acknowledge fast, process in the background. *Final, implemented Phase 2.*
- **D2** Dedupe on the payload body's own `id` field (what Quo's delivery-list API calls `eventId`) — **not** literally the `webhook-id` HTTP header, which is a different identifier. *Final, E1 confirmed stable (Phase 2).*
- **D3** SQLite outbox behind a small storage interface. *Final, implemented Phase 2/3 (`DeliveryStore`, `DomainStore`).*
- **D4** Verify the raw bytes before parsing. *Final, implemented Phase 1/2.*
- **D5** Return 401 on a bad signature, pending E5 (Phase 4).
- **D6** Svix for verification now; a hand-rolled version later as a learning exercise (still deferred, not started). *Final, implemented Phase 1.*
- **D7** Express (not Fastify). *Final, implemented Phase 2.*
- **D8** No `arrivals` table at first; one structured log line per arrival. **Promoted to a table in Phase 4**, once the experiments needed queryable data, as planned — with one addition beyond the originally documented schema (a `label` column for per-experiment aggregation; see `plan_deviations.md`).
- **D9** Lease-based worker claims. *Final, implemented Phase 3: 30s lease, 5 max attempts, exponential backoff capped at 60s with jitter.*
- **D10** Stale-event guard on upserts. *Final, implemented Phase 3. Per-event-type timestamp fields all confirmed against real captures: `message.received` → `data.resource.createdAt`; `call.completed` → `data.resource.completedAt`; `call.summary.completed` → top-level `createdAt` (its resource has no timestamp of its own — a documented exception to the general rule, not a violation of it).*

## 2. Phases

### Phase 0: Environment and ground truth (2 to 3 h) — ✅ Done
**Tasks**
- [x] Create or use a personal Quo workspace with a test phone number. Confirm webhook API access and generate an API key.
- [x] Install Node 22, cloudflared (or ngrok), sqlite3 CLI.
- [x] Create the repo (`quo-webhook-lab`), TypeScript strict config, Vitest, ESLint/Prettier, `.env.example`, `.gitignore` (data/, .env).
- [x] Create a beta webhook subscription (`POST /webhooks`, pinned API version) pointing at a tunnel URL; save the `whsec_` secret. (Detour: the dashboard form creates legacy-format webhooks, not beta — had to use the API directly. See `plan_deviations.md` V1.)
- [x] Fire a test event (`POST /webhooks/:id/events/test`) and capture one raw request (headers and body) to a fixtures folder, with personal data redacted.

**Acceptance:** met. Full detail in `phase_0_implementation_plan.md` and `phase_0_summary.md`.

### Phase 1: Signature verification (2 to 3 h) — ✅ Done
**Tasks**
- [x] `verifyQuoSignature(rawBody, headers, secret)` using Svix (D6).
- [ ] Follow-up, can wait: a small hand-rolled HMAC check as a learning exercise, tested against the same fixtures. *(Still deferred — not blocking, per D6.)*
- [x] Tests: valid signature; tampered body; wrong secret; missing headers; stale timestamp; future timestamp; multiple signatures in the header (after rotation). 10 tests total.
- [x] Verify the captured real delivery from Phase 0 passes. (Split into two tests once a real fixture ages past the 5-minute tolerance — see `bug_log.md` D1.)

**Acceptance:** met. Full detail in `phase_1_implementation_plan.md` and `phase_1_summary.md`.

### Phase 2: Ingest, arrival log and dedupe (3 to 4 h) — ✅ Done
**Tasks**
- [x] SQLite setup and schema (`deliveries` and the domain tables) behind a small storage interface (D3). No `arrivals` table yet (D8).
- [x] Express route with `express.raw()` mounted on the webhook route only, before any JSON parser (D4, D7); verify, write one structured log line per arrival (webhook id, event type, timestamp, outcome), insert with `ON CONFLICT DO NOTHING`, respond 200.
- [x] Tests (using supertest against the Express app with locally signed requests): accepted; duplicate returns 200 with one row and two logged arrivals; bad signature returns 401 and stores nothing; malformed JSON after valid signature.
- [x] Run against live Quo with the tunnel. Send several test events.
- [x] **Experiment E1 (stability of `webhook-id`).** Use manual retry for one delivery and confirm the retried delivery carries the same `webhook-id`. **Result: stable** — though "the id" turned out to be two different identifiers in reality; see D2 above and `plan_deviations.md` V2.

**Acceptance:** met — E1 confirmed stable, dedupe design held. Full detail in `phase_2_implementation_plan.md` and `phase_2_summary.md`.

### Phase 3: Worker and handlers (4 to 5 h) — ✅ Done
**Tasks**
- [x] Worker loop with lease-based claims, exponential backoff with jitter, `maxAttempts`, `dead` state. Injectable clock and random source for tests. Choose the lease duration here (D9); a crash during processing counts as an attempt. **30s lease, 5 max attempts.**
- [x] Handlers for `call.completed`, `call.summary.completed`, `message.received` with upserts and the stale-event guard.
- [x] Tests: success path; handler throws then succeeds on retry; poison event reaches `dead`; simulated crash (lease expiry) reclaims the row; out-of-order summary-before-call yields a correct joined read; stale event does not overwrite newer data. 26 tests total by end of phase.
- [x] `/healthz`, `/debug/deliveries`, `/debug/stats`, structured logging without payloads.

**Acceptance:** met. Also caught 3 real bugs along the way (`bug_log.md` P1–P3) — notably `call.summary.completed`'s timestamp field, which a real call proved wrong before the phase could close. Full detail in `phase_3_implementation_plan.md` and `phase_3_summary.md`.

### Phase 4: Fault injection and the retry experiments (4 to 6 h) — ✅ Done (except E8, deferred)
**Tasks**
- [x] Implement `FAULT_MODE` (`fail_first:N`, `slow:MS`, **plus a `status:CODE:N` variant** — needed for E4, not in the original scope; see `plan_deviations.md` V8).
- [x] Promote the arrival log lines to an `arrivals` table (D8). **Plus a `label` column** beyond `architecture.md` section 5's documented schema (`plan_deviations.md` V9).
- [x] Analyzer CLI: per-delivery arrival times, gaps, attempt counts, aggregate tables, export to CSV (`scripts/analyze.ts`).
- [x] Ran E2 through E7 live, one at a time, each with a fresh real event (test events proved unusable — see E2 below). Raw exports in `data/experiments/`.

| ID | Question | Method | Record |
|---|---|---|---|
| E1 | Is `webhook-id` stable across retries? | Manual retry of a delivered event | ids of both attempts — **done, Phase 2: confirmed stable, see D2 above** |
| E2 | What is the automatic retry schedule and attempt limit? | `fail_first:100` (always 500) | **Done.** 4 attempts observed over ~39 min, growing (not clean-doubling) gaps: 4.2s, 5m37s, 32m54s. Ceiling not confirmed (observation stopped by scope decision). **Side finding: test-triggered events get zero retries, ever** — real events required for every subsequent experiment. |
| E3 | What is the delivery timeout? | `slow:MS` for several values (2s, 5s, 10s, 30s) | **Done.** No retry at 2s/5s/10s; retry at 30s. Timeout bounded to (10s, 30s]. |
| E4 | Which status codes are retried? | `status:CODE:N`, **trimmed to 400/429/500/503** (4 of the original 8 — `plan_deviations.md` V10) | **Done.** All 4 retried, consistent ~5.1–5.2s regardless of code. **4xx retried identically to 5xx** — contradicts common webhook-provider convention. |
| E5 | What happens with a bad signature or after secret rotation? | Wrong secret, then rotate via the API | **Done.** 401 retries once (~5.2s, same timing as E4). Rotation + config update restores processing immediately, no propagation delay. |
| E6 | Does repeated failure disable the subscription? | Keep failing across several events | **Done, bounded result.** No status change observed across 3 events / ~90s. Not a claim it never happens — long-duration test not run. |
| E7 | Are events ordered? | Real call producing `call.completed` + `call.summary.completed` | **Done, single trial.** Order held on every axis. Caveat: tests a causally-dependent pair, not independent/concurrent events. |
| E8 | Does reconciliation recover an outage? | Stop the receiver, generate events, restart, run reconciler | **Deferred to after Phase 5** — needs the reconciler, which doesn't exist yet. |

**Acceptance:** met for E1–E7. Full write-ups and raw CSVs in `data/experiments/README.md`; detailed execution record in `phase_4_implementation_plan.md`.

### Phase 5: Reconciler and write-up (3 to 4 h)
**Tasks**
- [ ] Quo API client (list deliveries paged, get detail, retry, test event). The version header question is already settled (`Quo-Api-Version` only, confirmed Phase 0) — no need to send both spellings.
- [ ] Reconciler: dry-run by default, `--apply` to retry; pacing; tests with a mocked client.
- [ ] README: what it is, architecture diagram, quick start, how to run each experiment safely.
- [ ] `FINDINGS.md`: measured retry behavior with tables and caveats (beta API, date measured, API version `2026-03-30`).
- [ ] Clean repo hygiene: no secrets or personal data in history, MIT license, CI running typecheck and tests.

**Acceptance:** a stranger can clone, run tests and reproduce at least E1 and E2 from the README.

### Phase 6 (optional): Temporal variant and outreach (4 to 6 h)
**Tasks**
- [ ] Temporal dev server locally; workflow per delivery with `webhook-id` as workflow id; activity with a retry policy.
- [ ] Comparison write-up: lines of code, behavior under E2/E3-style failures, operational trade-offs.
- [ ] Decide how to share.

## 3. Test strategy
- **Unit:** verification, backoff math, upsert guards.
- **Integration (in-process):** supertest against the Express app with real SQLite (in-memory) covering ingest plus worker.
- **Contract (manual, live):** the experiments, using a real Quo workspace.
- **Deterministic time:** inject clock and random so backoff tests need no sleeping.
- **CI:** typecheck, lint, tests on every push; no live API calls in CI.

## 4. Risks and mitigations
| Risk | Likelihood | Mitigation |
|---|---|---|
| ~~`webhook-id` not stable across retries~~ | ~~Medium~~ | **Resolved, Phase 2: confirmed stable.** |
| Beta API changes mid-project | Medium | Pin `2026-03-30`; date-stamp findings |
| ~~Need a paid or specific plan for webhook or API access~~ | ~~Unknown~~ | **Resolved, Phase 0: full access, no paid-plan blocker hit.** |
| Test events do not mirror real event payloads | Medium | Also trigger real events from your own test number — **materialized exactly as feared**: test-triggered deliveries always carry a fixed canned payload and `eventId: null`; several real-event triggers were needed across Phases 0–3 specifically because test events weren't sufficient (E1, D10's per-event-type fields). |
| Accidentally logging personal data | Medium | No-payload logging, redacted fixtures, review before every push |
| Scope creep into a full product | High | Phase gates; the optional phase only after write-up |
| Experiments cost real credits (messages) | Low to medium | Prefer call and test events; check pricing before message-sending tests |

## 5. Open questions to resolve early
1. ~~Does your Quo plan include API and webhook access, and what are the limits?~~ — resolved: yes, full access used extensively through Phase 3. No limits hit yet.
2. Does Quo document the retry policy anywhere not yet found (support site, changelog)? — still open; Phase 4's E2 measures it empirically regardless, per the plan's "measure before assuming" principle.
3. ~~Which event types do you want as the main demo?~~ — resolved: all three (`call.completed`, `call.summary.completed`, `message.received`) — the subscription (Phase 0) and handlers (Phase 3) cover all of them, not just one family.
4. Hosting for the demo: local plus tunnel only, or a small deployed instance? — still open, a Phase 5/6 decision.
5. Optional: which web framework does Quo's team use? (D7 is settled as Express either way.) — not pursued, still optional.
6. ~~Does this build cover the webhook lab only, or also an inbound image pipeline?~~ — resolved: webhook lab only. No image-pipeline work exists anywhere in the project.

## 6. Definition of done
- [ ] Tests pass locally and in CI.
- [ ] E1 to E4 and E8 completed with raw data; E5 to E7 completed or explicitly skipped with reasons.
- [ ] `FINDINGS.md` published with dates and caveats.
- [ ] README lets a stranger reproduce E1 and E2.
- [ ] No secrets or personal data in the repository history.
