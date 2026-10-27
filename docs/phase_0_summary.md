# Phase 0 Summary: Environment and Ground Truth

Status: **Complete**. Executed 2026-10-27. Companion to `architecture.md` and `phase_0_implementation_plan.md` — this is the after-the-fact record of what actually happened, not the plan.

## What was built

- Public repo scaffolded and pushed: https://github.com/JasonEb/webhook-lab
- TypeScript (strict), ESLint flat config + Prettier, Vitest, Node 22 pinned via `mise.toml`
- Runtime deps installed: `express`, `better-sqlite3`, `svix`, `dotenv`
- `tsc --noEmit` and `eslint .` both pass clean
- `scripts/capture-once.ts`: a throwaway one-shot HTTP server used to capture raw headers/body of a single delivery, ahead of the real Express receiver (Phase 2)
- Note: TypeScript was pinned to `^5.9.3` instead of the newly-released TS 7, because `typescript-eslint@8.72.1` doesn't support TS 7 yet (`peer typescript@">=4.8.4 <6.1.0"`)

## Webhook subscription

- Created via direct API call (`POST https://api.quo.com/webhooks`), not the dashboard — see "Lessons" below for why
- `id: 47119`, `apiVersion: 2026-03-30`, `status: enabled`
- Events: `call.completed`, `call.summary.completed`, `message.received`
- `resourceIds: ["*"]` (left unscoped — see lessons on the `PN...` id confusion)
- Pointed at a temporary `cloudflared` quick tunnel, since torn down

## Ground truth captured

Two real deliveries, used to resolve open questions in `architecture.md` section 2:

1. **Synthetic test event** (`POST /webhooks/:id/events/test`, `call.completed`) → `fixtures/sample-delivery.json`. Contains Quo's fixed placeholder data, no real PII, so committed as-is (with the exact raw signed body preserved alongside a readable copy).
2. **Real text message** sent to the test number (`message.received`) → `fixtures/sample-message-delivery.json`. Contained a real phone number pair and real message text, redacted before commit per `architecture.md` section 8. Because redaction changes the bytes, this fixture is **not** valid for signature-verification tests — it documents payload shape only.

## Resolved unknowns (architecture.md section 2)

| Question | Answer |
|---|---|
| API version header | `Quo-Api-Version` only — no `x-quo-api-version` |
| Payload shape (beta) | `data.resource` + `data.context`, not `data.object` (legacy-only) |
| `webhook-timestamp` unit | Seconds (10-digit Unix epoch) |
| Signing headers | `webhook-id`/`webhook-timestamp`/`webhook-signature`, duplicated as `svix-id`/`svix-timestamp`/`svix-signature` with identical values; `webhook-test: true` present on test-triggered deliveries |
| D10 event-timestamp field | Use `data.resource.*` timestamps, not top-level `createdAt` — they differ (~211ms gap observed on one message; top-level is webhook-generation time, not domain-event time) |
| `resourceIds` format | Phone number **IDs** (`PN...`), not raw phone numbers |

## Still open

- Exact `data.resource` field carrying the event timestamp for `call.completed`/`call.summary.completed` specifically (confirmed for `message.received` only — need a real, non-test call to close this out)
- E1 (is `webhook-id` stable across retries?) — intentionally deferred to Phase 2 per the plan, not a Phase 0 blocker

## Lessons and incidents

- **The dashboard's "Create a webhook" form creates legacy-format webhooks**, not the beta ones this project targets. Confirmed two ways: `GET /webhooks` (beta API) returned an empty list after using the form, and a dashboard "send test request" delivered an `openphone-signature` header (legacy scheme) instead of `webhook-signature`. There's no visible beta-access toggle in the dashboard — the beta API appears to be API-only right now. Resolution: create subscriptions via direct `POST /webhooks` call instead.
- **The dashboard's "send test request" sends fixed canned data**, not real account resources. This surfaced as a `403 Forbidden: "You are forbidden to access the requested phone number IDs"` when a subscription create attempt reused a `phoneNumberId` lifted from that canned payload. The fake data (`+18005550100`, `AC...` ids) isn't tied to the actual workspace.
- **A captured real payload tripped GitHub secret-scanning push protection.** `data.resource.id` for a message activity is a Twilio-shaped identifier (`AC` + 32 hex chars, matching Twilio's Account SID format exactly) — Quo's infrastructure appears to be Twilio under the hood. GitHub blocked the push; fixing it required amending the commit that introduced it (not just a fix-forward commit), since push protection scans the full history of what's being pushed, not just the current tree.
- **Raw-byte fidelity matters for fixtures used in signature tests.** An early version of `fixtures/sample-delivery.json` stored the body pretty-printed as a nested JSON object instead of the exact string Quo signed — which would have silently broken Phase 1's "verify the real captured request passes" acceptance check. Fixed by storing both an exact `rawBody` string (for verification) and a readable `body` object (for humans).

## Artifacts

- Commits: `8420b10` (scaffold), `74dcb6c` (docs corrections), `368a3e3` (capture script + fixtures, amended once to strip the Twilio-shaped id before push)
- Repo: https://github.com/JasonEb/webhook-lab
- `.env` holds `QUO_API_KEY` and `QUO_WEBHOOK_SECRET` locally, untracked

---

**Next:** Phase 1, signature verification, using `fixtures/sample-delivery.json`'s `rawBody`.
