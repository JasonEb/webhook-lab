# Quo Webhook Lab

A production-shaped webhook receiver for Quo's beta webhooks, plus tooling to empirically measure how Quo's webhook delivery actually behaves — retry schedule, timeout, which status codes get retried, secret rotation recovery, and more.

Quo's documentation doesn't publish this behavior anywhere. Rather than assume or guess, this project built a small, correct receiver (ack-fast/process-later, idempotent handlers, dedupe, lease-based retry) and used it to measure the real thing against a live beta subscription. Full results are in [`FINDINGS.md`](FINDINGS.md).

**Status:** built and measured against the beta API, version `2026-03-30`, in late October 2026. This is a point-in-time measurement of a beta API — Quo can and likely will change this behavior. Don't treat anything here as a guarantee.

## Who this is for

- **Developers integrating with Quo's webhooks**, especially the beta API. The dashboard's "Create a webhook" form creates **legacy**-format webhooks, not beta ones — there's no visible UI for the beta API at all right now, only direct API calls (`architecture.md` section 2). If you're building a receiver for Quo, the working, tested reference code here (signature verification, raw-body handling, dedupe, idempotent handlers) and the measured retry/timeout/status-code behavior in `FINDINGS.md` answer questions Quo's own docs don't.
- **Anyone evaluating whether to build on Quo's beta webhooks at all.** `FINDINGS.md` gives real operational characteristics — delivery timeout bounds, how many retries to expect and over what timeframe, whether a 4xx error gets retried the same as a 5xx (it does, which is a real design consideration for how you handle validation errors), whether a failing subscription gets disabled — that matter for a go/no-go or design decision before committing engineering effort.
- **Quo's own engineering or platform team**, if this ever reaches them — it's an external, empirical read on how webhook delivery actually behaves versus how it might be intended to behave. The 4xx-retried-like-5xx finding in particular is the kind of thing worth a second look from the people who built the retry logic.
- **Anyone building a webhook *receiver* for a different provider entirely.** The architecture — acknowledge fast and process in a background worker, dedupe on the payload's own event id, lease-based retry with exponential backoff, idempotent upserts with a stale-event guard, fault injection for testing retry behavior safely — isn't Quo-specific. It's a reusable pattern for consuming any at-least-once webhook delivery system.

## Architecture

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
│  │  3 log arrival + record (arrivals table)                │          │
│  │  4 fault injector (experiments only)         ──status──>│          │
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
│   │ Reconciler (CLI)     │        │ Analyzer (CLI)           │        │
│   │ diff Quo deliveries  │        │ arrivals → retry gaps,   │        │
│   │ vs local, retry gaps │        │ attempt counts, timings  │        │
│   └──────────────────────┘        └──────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
```

Key design decisions and their rationale are in [`docs/architecture.md`](docs/architecture.md) section 6. The short version: acknowledge fast and process in a background worker (so a slow handler never causes Quo to see a timeout and retry unnecessarily), dedupe on the payload's own event id (not the `webhook-id` HTTP header — they're different identifiers, see `architecture.md` section 2), verify raw bytes before any JSON parsing, and treat every handler as idempotent since at-least-once delivery is the only guarantee webhooks provide.

## Quick start

```bash
git clone <this repo>
cd quo-webhooks-lab
mise use node@22          # or ensure Node 22+ some other way
npm install
cp .env.example .env      # fill in your own QUO_API_KEY / QUO_WEBHOOK_SECRET
npm run typecheck && npm run lint && npm test
```

Tests never make live API calls — they're safe to run with no `.env` at all (a few real-fixture checks skip gracefully without a configured secret).

## Running it for real

This needs a Quo account with beta webhook access (API-only right now — the dashboard's webhook UI creates **legacy**-format webhooks, not beta ones; see `docs/architecture.md` section 2) and a tunnel, since Quo needs to reach your machine over the public internet.

```bash
# 1. Expose localhost
cloudflared tunnel --url http://localhost:3000
# note the https://*.trycloudflare.com URL it prints

# 2. Point a beta subscription at it (first time) or repoint an existing one:
curl -X PATCH "https://api.quo.com/webhooks/{your-webhook-id}" \
  -H "Authorization: Bearer $QUO_API_KEY" \
  -H "Quo-Api-Version: 2026-03-30" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<tunnel-url>/webhooks/quo"}'

# 3. Run the receiver
npm run dev
```

The tunnel URL changes every time you restart it (it's a free "quick tunnel," not a stable address) — you'll need to repoint the subscription each session. This project did this dozens of times across its development; there's no way around it without paying for a stable tunnel or deploying somewhere permanent.

## Reproducing the experiments

**⚠️ `FAULT_MODE` makes this receiver intentionally return errors or respond slowly. Never set it against anything but your own personal test subscription, and never leave it set between experiments — the server prints a loud warning banner on startup if it's active, treat that as a stop sign if you didn't mean to set it.**

Every experiment follows the same shape: set `FAULT_MODE` (if the experiment needs it), restart the server, trigger **one real event** (not a test event — `POST /webhooks/:id/events/test` deliveries are never retried by Quo at all, confirmed in E2; they're not representative of anything), watch what happens, then analyze with `npm run analyze`.

### Reproducing E1 (is the dedupe key stable across retries?)

```bash
# Trigger a real event (send yourself a text, if testing message.received)
# Find its delivery id:
curl -s "https://api.quo.com/webhooks/{id}/events?limit=1" \
  -H "Authorization: Bearer $QUO_API_KEY" -H "Quo-Api-Version: 2026-03-30"
# Manually retry it:
curl -X POST "https://api.quo.com/webhooks/{id}/events/{deliveryId}/retry" \
  -H "Authorization: Bearer $QUO_API_KEY" -H "Quo-Api-Version: 2026-03-30"
# Compare the webhook-id header (or payload id) on both the original and retried delivery —
# they should match.
```

### Reproducing E2 (automatic retry schedule)

```bash
FAULT_MODE=fail_first:100 npm run dev
# Trigger one real event. Every attempt gets a 500. Watch the logs for retries.
# After a while (expect growing gaps — seconds, then minutes), stop and analyze:
npm run analyze -- --label your-label-here --csv data/experiments/my-e2.csv
```

Full experiment table (E1–E8), methods, and results: [`FINDINGS.md`](FINDINGS.md). Draft working notes with raw CSVs for every run: [`data/experiments/`](data/experiments/).

## Project structure

- `src/app.ts` — the Express ingest route (verify → dedupe → acknowledge)
- `src/worker.ts` — lease-based background worker (claim, dispatch, backoff, dead-letter)
- `src/handlers/` — per-event-type upsert handlers
- `src/db/` — SQLite storage (`DeliveryStore`, `DomainStore`, `ArrivalStore`)
- `src/faultInjector.ts` — `FAULT_MODE` for the experiments, disabled by default
- `src/quoApiClient.ts` / `src/reconciler.ts` — Quo API client and the outage-recovery reconciler
- `scripts/analyze.ts` — CLI for turning raw arrival data into retry-gap/timing analysis
- `scripts/reconcile.ts` — CLI for the reconciler (dry-run by default, `--apply` to retry)
- `docs/` — architecture, phase-by-phase implementation plans, and the full execution history (what was built, what broke, what the project's own plan got wrong along the way)

## License

MIT — see [`LICENSE`](LICENSE).
