# Phase 0: Environment and Ground Truth — Detailed Steps

Companion to `architecture.md` and `implementation_plan.md`. Expands Phase 0 (2 to 3 h) into concrete, ordered steps. Nothing here reopens D1 to D10; this phase only sets up tooling and captures one real delivery.

**Goal of this phase:** one real captured webhook request (headers + body) in a fixtures folder, with the actual header names, timestamp unit, and payload shape confirmed — and the `architecture.md` "Unknown" table updated accordingly. No receiver code is built yet; a throwaway capture script is enough.

---

## 0.1 Quo account and access

- [ ] Log into (or create) a personal Quo workspace. Use a workspace you own — never a customer's.
- [ ] Confirm the plan includes webhook + API access. If there's a gate (paid tier, waitlist, beta flag), resolve it before continuing — this is Risk #1 in the plan's risk table.
- [ ] Provision or confirm a test phone number on the workspace.
- [ ] Generate an API key from workspace settings. Note the exact scopes/permissions shown — record them in a comment in `.env.example` later, not in this doc.
- [ ] Do not paste the key into chat. Store it per the `.env` approach already agreed (step 0.4 below).

## 0.2 Local toolchain

Per your global setup, `mise` owns Node version, `brew` is the base package manager.

```bash
# Node 22, pinned per-project
mise use node@22
node -v        # confirm v22.x

# sqlite3 CLI for inspecting the local DB later
brew list sqlite3 || brew install sqlite3

# Tunnel: pick one
brew list cloudflared || brew install cloudflared
# or: brew list ngrok || brew install ngrok
```

- [ ] `mise use node@22` run from the project root (writes `mise.toml` once the repo exists — do this after 0.3, or run it again there).
- [ ] Confirm `node -v` and `npm -v` resolve to the mise-managed version, not a system Node.
- [ ] `cloudflared --version` or `ngrok version` runs without error.

## 0.3 Repo scaffold

```bash
cd /Users/jasonebueng/Dev_Projects/quo-webhooks-lab
git init
mise use node@22                 # writes mise.toml here
npm init -y
```

- [ ] `git init` (repo is currently not a git repo).
- [ ] `package.json` created; set `"type": "module"` and `"private": true`.
- [ ] Install core deps (used from Phase 1 on, but pin versions now so `npm ci` is reproducible):
  ```bash
  npm install express better-sqlite3 svix dotenv
  npm install -D typescript @types/node @types/express tsx vitest eslint prettier
  ```
- [ ] `tsconfig.json` with `"strict": true`, `"module": "NodeNext"`, `"target": "ES2022"`.
- [ ] `vitest.config.ts` minimal default config.
- [ ] ESLint + Prettier config (flat config for ESLint 9, matching the installed version).
- [ ] `.gitignore`:
  ```
  node_modules/
  data/
  .env
  *.log
  ```
- [ ] `.env.example`:
  ```
  QUO_API_KEY=
  QUO_WEBHOOK_SECRET=whsec_
  QUO_API_VERSION=2026-03-30
  PORT=3000
  ```
- [ ] Copy to real `.env` yourself (not via me) and fill in the real key/secret: `cp .env.example .env`.
- [ ] First commit: scaffold only, no secrets. Run `git status` before `git add` and eyeball the file list — `.env` must not appear.

## 0.4 Create the webhook subscription

Two equivalent ways to do this — pick one. Either way, only `events` and `url` are required; `resourceIds` takes phone number **IDs** (`PN...`), not raw phone numbers.

```bash
# Start the tunnel first so you have a URL to register
cloudflared tunnel --url http://localhost:3000
# note the https://*.trycloudflare.com URL it prints
```

**Option A — dashboard UI (recommended for this step):** it resolves the phone number → `PN...` ID mapping for you.
- [ ] URL: `<tunnel URL>/webhooks/quo`
- [ ] Label: `quo-webhook-lab-dev`
- [ ] Event types: check only `call.completed`, `call.summary.completed`, `message.received` (the only ones with handlers planned in Phase 3) — leave Contacts unchecked
- [ ] Turn off "Receive updates from all users" and select your one test phone number explicitly

**Option B — direct API call**, if you want to see the raw request/response shape:
```bash
curl -X POST <base URL>/webhooks \
  -H "Authorization: Bearer $QUO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Quo-Api-Version: 2026-03-30" \
  -d '{
    "events": ["call.completed", "call.summary.completed", "message.received"],
    "url": "<your tunnel URL>/webhooks/quo",
    "label": "quo-webhook-lab-dev",
    "resourceIds": ["<your test phone number PN... id>"]
  }'
```
  `<base URL>` isn't confirmed yet — check the API reference page itself for the actual host. To get the `PN...` id for your test number, check the phone number's settings page in the dashboard, or `GET /phone-numbers`.

- [ ] From the response, save: `data.id` (subscription id), `data.key` (the `whsec_...` signing secret), `data.apiVersion`. Put the secret in `.env` (`QUO_WEBHOOK_SECRET`), not in any committed file.

## 0.5 Minimal capture script (throwaway, not the real receiver)

You need raw headers + raw body of one real delivery before Phase 1 exists. Don't build the Express app yet — a ~15-line script is enough and keeps Phase 2 the first "real" implementation.

Create `scripts/capture-once.ts`:
```ts
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    writeFileSync("data/capture-raw.json", JSON.stringify({
      headers: req.headers,
      body,
    }, null, 2));
    res.writeHead(200).end();
    console.log("Captured one request to data/capture-raw.json");
    process.exit(0);
  });
}).listen(3000, () => console.log("Listening on :3000"));
```

- [ ] `mkdir -p data` (already gitignored).
- [ ] Run it: `npx tsx scripts/capture-once.ts`.
- [ ] Keep the tunnel from 0.4 pointed at `localhost:3000` (same URL already registered on the subscription).

## 0.6 Fire a test event and capture it

```bash
curl -X POST https://api.quo.com/webhooks/<subscription-id>/events/test \
  -H "Authorization: Bearer $QUO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Quo-Api-Version: 2026-03-30" \
  -d '{"eventType": "message.received"}'
```

Confirmed base URL: `https://api.quo.com` (no `/v1` prefix).

- [ ] Fire the test event while `capture-once.ts` is running.
- [ ] Confirm `data/capture-raw.json` was written and the script exited.
- [ ] Also trigger one **real** event from your test number if feasible (e.g., an actual call or message), per the plan's risk mitigation that test events may not mirror real payloads. Re-run the capture script for this second sample.

## 0.7 Redact and save as a fixture

- [ ] Open `data/capture-raw.json`. Identify any personal data: phone numbers, message text, names.
- [ ] Copy the relevant parts (headers especially: `webhook-id`, `webhook-timestamp`, `webhook-signature`, the version header actually sent) into a new, committed fixture, with phone numbers/text replaced by obvious placeholders (`+15550001234`, `"[redacted message body]"`).
- [ ] Save as `fixtures/sample-delivery.json` (create `fixtures/` if absent — this directory **is** committed, unlike `data/`).
- [ ] Double-check `fixtures/sample-delivery.json` before commit: `git diff --staged` and read it, not just skim.

## 0.8 Resolve the open unknowns this phase can answer

From `architecture.md` section 2, this phase should resolve:

- [x] **Payload shape** — beta uses `data.resource` + `data.context`, confirmed via a real (test) delivery captured 2026-10-27. `architecture.md` section 2 updated.
- [x] **Timestamp unit** — `webhook-timestamp` is seconds (10-digit epoch), confirmed 2026-10-27.
- [x] **API version header name** — confirmed `Quo-Api-Version` via the API reference; `architecture.md` section 2 already updated.
- [x] **Event timestamp field for D10** — confirmed via a real (non-test) `message.received` delivery 2026-10-27: use `data.resource.*` timestamps, not top-level `createdAt` (they differ — top-level is webhook-generation time). Exact field for `call.completed`/`call.summary.completed` still TBD, general rule is settled. `architecture.md` section 2 updated.
- [x] Edited `architecture.md` section 2: moved payload shape, timestamp unit, and header name into "Documented"; narrowed the D10 field question and E1 (webhook-id stability) notes in "Unknown."

## 0.9 Acceptance checklist (must all be true to close Phase 0)

- [x] Repo exists, is a git repo, builds (`tsc --noEmit` and `eslint .` both pass).
- [x] `.env` holds real secrets (`QUO_API_KEY`, `QUO_WEBHOOK_SECRET`) and is confirmed absent from `git status` / history.
- [x] A live webhook subscription exists (id `47119`, beta API `2026-03-30`), pointed at a tunnel URL.
- [x] `fixtures/sample-delivery.json` exists, committed (no redaction needed — Quo's test endpoint sends synthetic placeholder data, not real PII).
- [x] `architecture.md` section 2 updated with resolved unknowns and today's date (2026-10-27).
- [x] You can state, from direct evidence: the real header names (`webhook-id`/`webhook-timestamp`/`webhook-signature` + duplicate `svix-*`), the timestamp unit (seconds), and the payload shape (`data.resource` + `data.context`).
- [ ] Tunnel URL used for setup is noted as temporary — plan to tear it down when not actively testing (per architecture.md section 8). **Still running** (`read-published-abilities-many.trycloudflare.com`) — tear down once Phase 0 wraps.
- [x] A real (non-test, non-synthetic) event captured and the D10 event-timestamp question resolved (see above). `data/capture-raw.json` (gitignored, contains real phone numbers/text) superseded by the redacted `fixtures/sample-message-delivery.json`.

---

**Next:** Phase 1, signature verification — write failing tests first against `fixtures/sample-delivery.json`.
