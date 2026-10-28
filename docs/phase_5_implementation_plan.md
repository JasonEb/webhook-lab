# Phase 5: Reconciler and Write-Up — Detailed Steps

Companion to `architecture.md` and `implementation_plan.md`. Expands Phase 5 (3 to 4 h) into concrete steps. Builds on Phase 4's confirmed API surface (`GET /webhooks/{id}/events`, `PATCH /webhooks/{id}`, `POST /webhooks/{id}/events/{deliveryId}/retry`) and finally unblocks **E8**, which has been deferred since Phase 4 because it needs the reconciler this phase builds.

**Goal of this phase:** a working reconciler (dry-run by default), E8 run live to close out the experiment set, a public-facing `README.md`, a polished `FINDINGS.md` folding in all of Phase 4's draft results, and repo hygiene (license, CI, a final secrets/PII audit) — the point where this becomes a shareable public repo, not just a personal lab.

---

## 5.0 Two things to confirm from the docs before writing the client — don't assume

Two details the project doesn't actually have confirmed yet, found by re-reading what's already documented rather than assuming the obvious:

1. **Does `GET /webhooks/{webhookId}/events` paginate?** `architecture.md` section 2 documents the confirmed field list (`id`, `eventId`, `resourceId`, `eventType`, `status`, `nextAttemptAt`, `createdAt`) but every call made so far (Phase 2, Phase 4) returned a small result set in one page. The sibling `GET /webhooks` endpoint does return a `nextCursor` field — check whether the deliveries-list endpoint has the same shape before assuming a cursor param exists, rather than writing pagination code against a guess.
2. **Is there a single-delivery-detail endpoint**, distinct from the list? `implementation_plan.md`'s Phase 5 task says "get detail" as if one exists separately from `GET /webhooks/{id}/events`. Not confirmed anywhere in this project's history. If it doesn't exist, the reconciler works entirely off the list endpoint's fields, which is probably sufficient anyway (`status` + `eventId` + `createdAt` is enough to drive reconciliation).

- [ ] Check `https://www.quo.com/docs/llms.txt` (the index that already helped find the real endpoints in Phase 2) for both of these before writing `QuoApiClient`. Update `architecture.md` section 2 with whatever's found — confirmed-paginated-or-not, detail-endpoint-exists-or-not.

## 5.1 `QuoApiClient`

A small interface, mirroring the `DeliveryStore`/`DomainStore` pattern — concrete methods only for what the reconciler actually needs, not a general-purpose Quo SDK.

```ts
export interface DeliverySummary {
  id: string;
  eventId: string | null;
  eventType: string;
  status: "success" | "pending" | "sending" | "failed";
  createdAt: string;
}

export interface QuoApiClient {
  listDeliveries(webhookId: string): Promise<DeliverySummary[]>; // handles pagination internally if 5.0 confirms it exists
  retryDelivery(webhookId: string, deliveryId: string): Promise<void>;
}
```

- [ ] Implement in `src/quoApiClient.ts` using `fetch` (Node 22 has it built in — no need for a new HTTP client dependency).
- [ ] `Quo-Api-Version: 2026-03-30` header on every call — confirmed as the only required version header since Phase 0, no need to send the alternate spelling (`implementation_plan.md` already corrected this stale task).
- [ ] If pagination is confirmed in 5.0, `listDeliveries` loops internally and returns the full flattened list — callers shouldn't need to know about cursors.
- [ ] **Filter out test deliveries** (`eventId: null`) before returning — they're not reconcilable (D2's dedupe key doesn't exist for them), and Phase 4's E2 already established they're not subject to the real retry machinery either. Returning them to the reconciler would just create confusing no-op candidates.

## 5.2 Reconciler logic

Per `architecture.md` 4.5: compare Quo's delivery list against the local `deliveries` table, retry anything that failed on Quo's side and is missing locally.

```ts
export interface ReconcileCandidate {
  deliveryId: string;
  eventId: string;
  eventType: string;
  quoStatus: string;
}

export function findReconcileCandidates(
  quoDeliveries: DeliverySummary[],
  localWebhookIds: Set<string>, // from DeliveryStore — every webhook_id we already have
): ReconcileCandidate[] {
  return quoDeliveries
    .filter((d) => d.eventId !== null && d.status === "failed" && !localWebhookIds.has(d.eventId))
    .map((d) => ({ deliveryId: d.id, eventId: d.eventId as string, eventType: d.eventType, quoStatus: d.status }));
}
```

- [ ] Implement `findReconcileCandidates` as a pure function (easy to unit test, per 5.3) — the impure parts (fetching from Quo, reading local DB, calling retry) stay in a thin wrapper around it.
- [ ] **D3's point about dedupe applies directly here**: "Dedupe makes it safe to retry something we may already have" (`architecture.md` 4.5). Don't over-engineer the "missing locally" check — `localWebhookIds.has(d.eventId)` is a simple presence check, not a status comparison. If we have *any* row for that `eventId`, don't touch it; our own dedupe logic (D2) already handles the case where a retry arrives for something we already processed.

## 5.3 Reconciler CLI, dry-run by default

`scripts/reconcile.ts`:
- [ ] `mise exec -- npx tsx scripts/reconcile.ts` — dry run, prints candidates (delivery id, event id, event type, Quo status) without calling anything.
- [ ] `--apply` flag — actually calls `retryDelivery` for each candidate.
- [ ] **Pacing**: a small delay between retry calls (e.g. 500ms–1s) when `--apply` is set — "polite request pacing" per `architecture.md` 4.5, avoiding hammering Quo's API even though this is a personal low-volume lab.
- [ ] Print a summary at the end: N candidates found, N retried (if `--apply`), N skipped (test deliveries filtered, already-present deliveries).

## 5.4 Tests with a mocked client

- [ ] `findReconcileCandidates` unit tests: a mix of `success`/`pending`/`sending`/`failed` Quo statuses, some with `eventId: null` (test deliveries — must be excluded), some matching an existing local `webhook_id` (must be excluded), confirm only genuinely-missing-and-failed deliveries come back.
- [ ] A reconciler-flow test with a stub `QuoApiClient` (no real HTTP) — confirm dry-run calls `retryDelivery` zero times, `--apply` calls it exactly once per candidate.
- [ ] No live API calls in any test, per the project's existing CI principle (`implementation_plan.md` section 3) — this was already true for every prior phase's test suite and stays true here.

## 5.5 Run E8 live — the payoff for building this

**Question:** does reconciliation recover an outage?

- [ ] Stop the receiver entirely (not fault-injecting — the process isn't running at all, so Quo gets connection failures/timeouts, not an HTTP error response). This is a genuinely different failure mode from anything tested in Phase 4.
- [ ] Trigger a real event (or two) while the receiver is down.
- [ ] Wait briefly, then restart the receiver normally (no `FAULT_MODE`).
- [ ] Check `GET /webhooks/47119/events` — does the missed delivery show up with `status: "failed"`? (Worth noting if Quo's automatic retry schedule, per E2, already redelivers it on its own before you even run the reconciler — if so, the reconciler's dry-run should correctly show **zero candidates**, which is itself a valid and informative result, not a failed experiment.)
- [ ] Run the reconciler dry-run, then `--apply` if there are genuine candidates.
- [ ] Confirm: the missed event eventually lands in the local `deliveries` table, with no duplicate row (D2's dedupe doing its job across a reconciler-triggered retry, not just an automatic one).
- [ ] Record the result in `data/experiments/README.md`, same format as E1–E7, and update `implementation_plan.md`'s E8 row from "deferred" to done.

## 5.6 `README.md`

Public-facing — this is what a stranger cloning the repo sees first.

- [ ] What the project is and why (condensed from `architecture.md` section 1).
- [ ] Architecture diagram — adapt the ASCII diagram from `architecture.md` section 3, don't just paste it verbatim if it's grown stale; check it against what actually got built.
- [ ] Quick start: clone, `mise use node@22` (or whatever's current), `npm install`, `npm run typecheck && npm run lint && npm test`.
- [ ] **How to run each experiment safely** — this needs to be honest about the live-testing dance every phase went through: a tunnel is required, `FAULT_MODE` must never be left on, the subscription URL needs repointing each session. Don't write this as if it's a one-command `npm run experiment` — it wasn't, and pretending otherwise would make the README misleading to someone trying to reproduce it.
- [ ] Per the acceptance criterion below, explicitly walk through reproducing **E1 and E2** step by step, since those are the ones a stranger needs to be able to redo.

## 5.7 `FINDINGS.md`

The polished version of `data/experiments/README.md`'s draft notes.

- [ ] Date-stamp it and state the API version tested (`2026-03-30`) and that this is a **beta** API — behavior can change (`architecture.md` section 2's documented/unknown distinction still applies: state what's confirmed, flag what's bounded-but-not-definitive, like E2's unconfirmed max-attempts ceiling or E6's short observation window).
- [ ] Fold in all of E1–E8's results from `data/experiments/README.md`, tightened into a findings-report tone rather than a working-notes tone — but **don't soften the real findings**, especially E4's "4xx retries identically to 5xx" result, which contradicts common webhook-provider convention and is one of the most notable results this project produced.
- [ ] Caveats section: beta API, single workspace tested, several experiments intentionally bounded in scope rather than run to exhaustion (E2's ceiling, E6's window, E7's single causally-dependent trial) — list these explicitly rather than letting the polished document imply more certainty than the raw data supports.

## 5.8 Repo hygiene

- [ ] `LICENSE` file, MIT, matching `package.json`'s `license` field (currently the `npm init` default `ISC` — update it).
- [ ] Final audit: `git log -p | grep -iE 'whsec_|AC[0-9a-f]{32}'` (or similar) across the full history, not just the current tree — the Phase 0 secret-scanning incident (`plan_deviations.md`, the amended commit) means this project has already had one near-miss; a final explicit pass before calling the repo "clean" is warranted, not paranoid.
- [ ] CI (GitHub Actions): typecheck, lint, test on every push. **No live API calls, no secrets in CI** — the existing `skipIf(!realSecret)` pattern (Phase 1 onward) already makes the test suite safe to run with no `QUO_WEBHOOK_SECRET` configured; don't add one as a GitHub Actions secret, let the tests skip as designed.

## 5.9 Acceptance checklist (must all be true to close Phase 5)

- [ ] 5.0's two open questions resolved and `architecture.md` updated either way.
- [ ] `QuoApiClient` and reconciler implemented, tested with a mocked client, no live calls in tests.
- [ ] Reconciler CLI works: dry-run shows candidates without acting, `--apply` actually retries, with pacing.
- [ ] **E8 run live and recorded** — this is the hard requirement this phase exists to unblock, per `implementation_plan.md`'s original "E1 to E4 and E8 completed with raw data" framing (E5–E7 were already a bonus beyond what was strictly required).
- [ ] `README.md` published, walks a stranger through reproducing E1 and E2 specifically (the stated acceptance bar).
- [ ] `FINDINGS.md` published, dated, scoped honestly, includes every experiment's real result including the ones that contradict common assumptions.
- [ ] `LICENSE` added, `package.json` license field matches.
- [ ] Full git history audited for secrets/PII, not just the current working tree.
- [ ] CI configured and passing (typecheck, lint, test), no live API dependency.
- [ ] `tsc --noEmit` and `eslint .` clean; all prior tests still pass.
- [ ] New bugs/deviations found while executing this phase logged in `bug_log.md`/`plan_deviations.md`, same habit as every phase since Phase 3.

---

**Next:** Phase 6 (optional) — Temporal variant and outreach. Only after this phase's write-up is genuinely done, per `implementation_plan.md`'s phase-gating risk mitigation ("scope creep into a full product").
