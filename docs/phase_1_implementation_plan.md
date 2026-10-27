# Phase 1: Signature Verification — Detailed Steps

Companion to `architecture.md` and `implementation_plan.md`. Expands Phase 1 (2 to 3 h) into concrete steps. Builds on Phase 0's `fixtures/sample-delivery.json`, which now stores both an exact `rawBody` string (byte-for-byte what Quo signed) and a pretty-printed `body` for readability — **tests must use `rawBody`**, not `body`.

**Goal of this phase:** `verifyQuoSignature(rawBody, headers, secret)` exists, is fully unit-tested (valid, tampered, wrong secret, missing headers, stale/future timestamp, rotation), and verifies the real Phase 0 capture. No JSON parsing happens before signature verification (D4).

---

## 1.1 Confirmed facts about the `svix` library (from reading `node_modules/svix` and `node_modules/standardwebhooks` source, since the public docs don't cover this level of detail)

- `svix`'s `Webhook` class wraps `standardwebhooks`'s `Webhook` class. Construct with `new Webhook(secret)` where `secret` is the `whsec_...` string.
- `.verify(payload: string | Buffer, headers: Record<string, string>): undefined` — throws `WebhookVerificationError` on failure, returns `undefined` (not the parsed body) on success. The `svix` wrapper always calls the inner verify with `{ jsonParse: false }`, so **no JSON parsing ever happens inside verify** — this satisfies D4 automatically. Parse the body yourself, after verification succeeds.
- Header lookup is case-insensitive and accepts either `svix-*` or `webhook-*` header names (it normalizes both to `webhook-*` internally, falling back `svix-id ?? webhook-id`, etc.). Since Quo sends both sets with identical values, either naming works.
- Exact error messages thrown (`WebhookVerificationError.message`): `"Missing required headers"`, `"Invalid Signature Headers"` (timestamp not parseable), `"Message timestamp too old"`, `"Message timestamp too new"`, `"No matching signature found"` (bad signature/tampered body/wrong secret all land here).
- Timestamp tolerance is hardcoded to **5 minutes (300s) in both directions** — not configurable.
- `.sign(msgId: string, timestamp: Date, payload: string | Buffer): string` returns `"v1,<base64-hmac>"` — this is how we'll generate valid signatures for test fixtures, using a throwaway test secret (never the real one).
- The signature header supports **multiple space-separated `v1,<sig>` entries**; verify loops through all of them and succeeds on the first match. This is exactly the key-rotation case — during rotation Quo would send both old and new signatures until the old key is retired.

## 1.2 Write `src/verifyQuoSignature.ts`

```ts
import { Webhook } from "svix";

export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureVerificationError";
  }
}

export function verifyQuoSignature(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): void {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      normalized[key] = value[0] as string;
    }
  }

  const webhook = new Webhook(secret);
  try {
    webhook.verify(rawBody, normalized);
  } catch (err) {
    throw new SignatureVerificationError(err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] Create the file as above.
- [ ] Note the `headers` param type accepts Express/Node's `IncomingHttpHeaders` shape (`string | string[] | undefined`) directly, so the real route handler (Phase 2) can pass `req.headers` with no adapter.
- [ ] `verify()` returning `undefined` on success (not throwing) *is* the success signal — callers check "did it throw," they don't check a return value.

## 1.3 Test secret setup — throwaway, not the real one

Tests must never use the real `QUO_WEBHOOK_SECRET`. Define a local test-only secret at the top of the test file:

```ts
const TEST_SECRET = "whsec_" + Buffer.from("test-secret-for-quo-webhook-lab-phase1").toString("base64");
```

A helper to sign a payload for test fixtures, using `svix`'s own `.sign()`:

```ts
import { Webhook } from "svix";

function signPayload(secret: string, msgId: string, timestamp: Date, payload: string) {
  return new Webhook(secret).sign(msgId, timestamp, payload);
}

function buildHeaders(msgId: string, timestamp: Date, signature: string) {
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": signature,
  };
}
```

## 1.4 Test: valid signature passes

```ts
it("accepts a validly signed request", () => {
  const payload = '{"type":"call.completed"}';
  const msgId = "msg_test1";
  const timestamp = new Date();
  const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
  expect(() =>
    verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), TEST_SECRET),
  ).not.toThrow();
});
```

- [ ] Write this test.

## 1.5 Test: tampered body is rejected

Sign one payload, then verify a *different* payload with that signature.

```ts
it("rejects a tampered body", () => {
  const original = '{"type":"call.completed"}';
  const tampered = '{"type":"call.completed","amount":999999}';
  const msgId = "msg_test2";
  const timestamp = new Date();
  const sig = signPayload(TEST_SECRET, msgId, timestamp, original);
  expect(() =>
    verifyQuoSignature(tampered, buildHeaders(msgId, timestamp, sig), TEST_SECRET),
  ).toThrow(SignatureVerificationError);
});
```

- [ ] Write this test. Assert the thrown error's `.message` is `"No matching signature found"` for clarity (not required, but documents behavior).

## 1.6 Test: wrong secret is rejected

```ts
it("rejects a signature made with a different secret", () => {
  const payload = '{"type":"call.completed"}';
  const msgId = "msg_test3";
  const timestamp = new Date();
  const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
  const wrongSecret = "whsec_" + Buffer.from("a-completely-different-secret-value").toString("base64");
  expect(() =>
    verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), wrongSecret),
  ).toThrow(SignatureVerificationError);
});
```

- [ ] Write this test.

## 1.7 Test: missing headers rejected

```ts
it("rejects a request missing signature headers", () => {
  const payload = '{"type":"call.completed"}';
  expect(() => verifyQuoSignature(payload, {}, TEST_SECRET)).toThrow(SignatureVerificationError);
});
```

- [ ] Write this test. Also cover the partial case — only `webhook-id` present, signature/timestamp missing — in a second assertion or a `.each` table, since architecture.md's failure-mode table treats any missing header as a full rejection, not a partial one.

## 1.8 Test: stale timestamp rejected

Tolerance is exactly 300s. Use a timestamp clearly outside it (6 minutes) to avoid flakiness from test runtime jitter near the boundary.

```ts
it("rejects a timestamp older than 5 minutes", () => {
  const payload = '{"type":"call.completed"}';
  const msgId = "msg_test4";
  const timestamp = new Date(Date.now() - 6 * 60 * 1000);
  const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
  expect(() =>
    verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), TEST_SECRET),
  ).toThrow(/too old/);
});
```

- [ ] Write this test.

## 1.9 Test: future timestamp rejected

Same shape, `+6 * 60 * 1000`, expect `/too new/`.

- [ ] Write this test.

## 1.10 Test: multiple signatures in header (rotation)

Simulates Quo sending both the old and new signature during a secret rotation window. Verification should succeed as long as *one* of them matches the secret in use.

```ts
it("accepts a request with multiple signatures when one matches (rotation)", () => {
  const payload = '{"type":"call.completed"}';
  const msgId = "msg_test5";
  const timestamp = new Date();
  const oldSecret = "whsec_" + Buffer.from("old-secret-before-rotation").toString("base64");
  const newSecret = TEST_SECRET;
  const oldSig = signPayload(oldSecret, msgId, timestamp, payload);
  const newSig = signPayload(newSecret, msgId, timestamp, payload);
  const headers = buildHeaders(msgId, timestamp, `${oldSig} ${newSig}`);
  expect(() => verifyQuoSignature(payload, headers, newSecret)).not.toThrow();
});
```

- [ ] Write this test.

## 1.11 Test: the real Phase 0 capture verifies

This is the plan's explicit acceptance criterion — distinct from the synthetic tests above because it uses `fixtures/sample-delivery.json`'s real headers/body and the **real** secret from `.env`, not a throwaway test secret. It must not run in CI (no secret there), so skip when the env var is absent.

**Important wrinkle discovered while implementing this:** the 5-minute timestamp tolerance (1.1) means a fixture captured once and replayed later will *always* fail a literal `verifyQuoSignature()` call once more than 5 minutes have passed — this is correct behavior, not a bug, but it means "the real capture verifies" can't be checked with a single naive `.not.toThrow()` once any real time has elapsed since capture. Split into two tests instead:

```ts
import { readFileSync } from "node:fs";
import { Webhook } from "svix";
import "dotenv/config";

const fixture = JSON.parse(readFileSync("fixtures/sample-delivery.json", "utf8"));
const realSecret = process.env.QUO_WEBHOOK_SECRET;

// Cryptographic authenticity, independent of wall-clock tolerance: recompute the
// signature using sign() with the fixture's own timestamp, and confirm it's one of
// the signatures Quo actually sent.
it.skipIf(!realSecret)("the real captured delivery's signature matches what the real secret produces", () => {
  const timestamp = new Date(Number(fixture.headers["webhook-timestamp"]) * 1000);
  const expectedSig = new Webhook(realSecret as string).sign(
    fixture.headers["webhook-id"], timestamp, fixture.rawBody,
  );
  expect(fixture.headers["webhook-signature"].split(" ")).toContain(expectedSig);
});

// Document that verifyQuoSignature correctly rejects the now-aged fixture, rather than
// silently mis-verifying it.
it.skipIf(!realSecret)("verifyQuoSignature correctly rejects the real capture once it is outside the 5-minute tolerance", () => {
  expect(() => verifyQuoSignature(fixture.rawBody, fixture.headers, realSecret as string)).toThrow(/too old/);
});
```

- [ ] Write both tests.
- [ ] Run locally (where `.env` has the real secret) and confirm both pass — this is the actual acceptance gate, not just "tests are green."
- [ ] Confirm both are skipped, not failed, when run without `.env` (simulate: `QUO_WEBHOOK_SECRET= npx vitest run` or temporarily rename `.env`).
- [ ] If you ever want a true end-to-end "capture and immediately verify" check, it has to happen within 5 minutes of capture — e.g. a manual one-off script run right after Phase 0's capture step, not a permanent part of the test suite.

## 1.12 Follow-up (can wait, per D6): hand-rolled HMAC check

Explicitly deferred — D6 says Svix now, a hand-rolled version later as a learning exercise. Do not build this in Phase 1; note it as a follow-up item only.

- [ ] Add a one-line TODO comment or defer entirely — do not implement this now.

## 1.13 Run full verification

```bash
mise exec -- npx tsc --noEmit
mise exec -- npx eslint .
mise exec -- npx vitest run
```

- [ ] `tsc --noEmit` passes.
- [ ] `eslint .` passes.
- [ ] `vitest run` — all tests green, including the real-fixture test (run locally with `.env` present).

## 1.14 Acceptance checklist (must all be true to close Phase 1)

- [x] `src/verifyQuoSignature.ts` exists, exports `verifyQuoSignature` and `SignatureVerificationError`.
- [x] No JSON parsing happens inside `verifyQuoSignature` or before it's called — the `svix` wrapper forces `jsonParse: false` internally; confirmed by reading `node_modules/svix/src/webhook.ts`.
- [x] All test cases exist and pass (10 total, one case split into two for missing-headers and two for the real fixture): valid, tampered, wrong secret, missing headers (full + partial), stale timestamp, future timestamp, multi-signature rotation, real fixture (signature authenticity + correct staleness rejection).
- [x] The real Phase 0 capture (`fixtures/sample-delivery.json`) is cryptographically confirmed against the real secret, and `verifyQuoSignature` is confirmed to correctly reject it as stale now that time has passed since capture — both run locally with `.env` present, not assumed.
- [x] `tsc --noEmit` and `eslint .` both pass clean.
- [x] No real secret appears anywhere in committed code or fixtures (only `whsec_`-prefixed throwaway test secrets in test files; the real secret is read from `.env` at test time only, via `skipIf`).
- [x] Confirmed the real-fixture tests skip (not fail) when `QUO_WEBHOOK_SECRET` is absent (`QUO_WEBHOOK_SECRET= npx vitest run` → 8 passed, 2 skipped).

---

**Next:** Phase 2, ingest/arrival-log/dedupe — wires `verifyQuoSignature` into an actual Express route with `express.raw()`, SQLite, and the E1 experiment (is `webhook-id` stable across retries?).
