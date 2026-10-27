# Phase 1 Summary: Signature Verification

Status: **Complete**. Executed 2026-10-27. Companion to `architecture.md` and `phase_1_implementation_plan.md` — this is the after-the-fact record of what actually happened, not the plan.

## What was built

- `src/verifyQuoSignature.ts` — `verifyQuoSignature(rawBody, headers, secret)`, wrapping the `svix` library. Throws `SignatureVerificationError` on any failure; returns `undefined` (not the parsed body) on success, since no JSON parsing happens inside it (D4).
- `src/verifyQuoSignature.test.ts` — 10 tests: valid signature, tampered body, wrong secret, missing headers (full and partial), stale timestamp, future timestamp, multi-signature rotation, and two tests against the real Phase 0 capture.
- Fixed `tsconfig.json`: `rootDir: "src"` broke as soon as a second source directory (`scripts/`) existed. Removed the constraint rather than split the project into multiple `tsconfig` projects, since nothing currently depends on a strict `rootDir`-based output layout.

## Facts confirmed by reading the `svix`/`standardwebhooks` source

The public docs don't cover this level of detail, so these came from reading `node_modules/svix/src/webhook.ts` and `node_modules/standardwebhooks/dist/index.js` directly:

- Timestamp tolerance is hardcoded to exactly **5 minutes (300s) in both directions** — not configurable.
- The signature header supports multiple space-separated `v1,<sig>` entries; verification succeeds if *any* one matches — this is how key rotation is meant to work (old and new signature sent together during the rotation window).
- Header lookup is case-insensitive and accepts either `svix-*` or `webhook-*` names interchangeably (falls back `svix-id ?? webhook-id`, etc.).
- The `svix` wrapper always calls the inner `verify()` with `{ jsonParse: false }` — so D4 ("no parsing before verification") is enforced by the library itself, not just by our code's call order.
- Exact thrown error messages: `"Missing required headers"`, `"Invalid Signature Headers"`, `"Message timestamp too old"`, `"Message timestamp too new"`, `"No matching signature found"` (this last one covers tampered bodies, wrong secrets, and bad signatures alike — verification can't distinguish *why* a signature doesn't match).

## A real finding mid-implementation: captured fixtures age out

The first version of the "verify the real Phase 0 capture" test asserted `verifyQuoSignature(fixture.rawBody, fixture.headers, realSecret)` doesn't throw. It failed — not a bug, but because hours had passed since Phase 0's capture, and the 5-minute tolerance correctly rejected it as stale. A fixture captured once and replayed later will *always* eventually fail a literal `verifyQuoSignature()` call, no matter how correct the implementation is.

Resolved by splitting into two tests:
1. Cryptographic authenticity, independent of wall-clock tolerance — recompute the signature via `Webhook.sign()` using the fixture's own stored timestamp, and confirm it matches what Quo actually sent.
2. A test documenting that `verifyQuoSignature` correctly rejects the now-aged fixture, rather than silently mis-verifying it.

Both pass against the real secret, and both skip cleanly (via `it.skipIf`) when `QUO_WEBHOOK_SECRET` is absent, so this never depends on a real secret in CI.

## Acceptance

- All 10 tests pass locally (`.env` present): `8 passed | 2 skipped` without the secret, confirmed deliberately by running with `QUO_WEBHOOK_SECRET=` to verify the skip path works, not just the pass path.
- `tsc --noEmit` and `eslint .` both pass clean.
- No real secret anywhere in committed code — only `whsec_`-prefixed throwaway test secrets in test files; the real one is read from `.env` at test time only.

## Artifacts

- `src/verifyQuoSignature.ts`, `src/verifyQuoSignature.test.ts`
- `tsconfig.json` fix (removed `rootDir`)
- Not committed as of this summary — bundled with Phase 2's commit.

---

**Next:** Phase 2, ingest/arrival-log/dedupe — wires `verifyQuoSignature` into a real Express route.
