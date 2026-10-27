import { readFileSync } from "node:fs";
import { Webhook } from "svix";
import { describe, expect, it } from "vitest";
import "dotenv/config";
import { SignatureVerificationError, verifyQuoSignature } from "./verifyQuoSignature.js";

const TEST_SECRET =
  "whsec_" + Buffer.from("test-secret-for-quo-webhook-lab-phase1").toString("base64");

function signPayload(secret: string, msgId: string, timestamp: Date, payload: string): string {
  return new Webhook(secret).sign(msgId, timestamp, payload);
}

function buildHeaders(msgId: string, timestamp: Date, signature: string) {
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": signature,
  };
}

describe("verifyQuoSignature", () => {
  it("accepts a validly signed request", () => {
    const payload = '{"type":"call.completed"}';
    const msgId = "msg_test1";
    const timestamp = new Date();
    const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
    expect(() =>
      verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), TEST_SECRET),
    ).not.toThrow();
  });

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

  it("rejects a signature made with a different secret", () => {
    const payload = '{"type":"call.completed"}';
    const msgId = "msg_test3";
    const timestamp = new Date();
    const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
    const wrongSecret =
      "whsec_" + Buffer.from("a-completely-different-secret-value").toString("base64");
    expect(() =>
      verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), wrongSecret),
    ).toThrow(SignatureVerificationError);
  });

  it("rejects a request missing all signature headers", () => {
    const payload = '{"type":"call.completed"}';
    expect(() => verifyQuoSignature(payload, {}, TEST_SECRET)).toThrow(
      SignatureVerificationError,
    );
  });

  it("rejects a request missing the signature header only", () => {
    const payload = '{"type":"call.completed"}';
    expect(() =>
      verifyQuoSignature(
        payload,
        { "webhook-id": "msg_test", "webhook-timestamp": "1700000000" },
        TEST_SECRET,
      ),
    ).toThrow(SignatureVerificationError);
  });

  it("rejects a timestamp older than 5 minutes", () => {
    const payload = '{"type":"call.completed"}';
    const msgId = "msg_test4";
    const timestamp = new Date(Date.now() - 6 * 60 * 1000);
    const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
    expect(() =>
      verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), TEST_SECRET),
    ).toThrow(/too old/);
  });

  it("rejects a timestamp more than 5 minutes in the future", () => {
    const payload = '{"type":"call.completed"}';
    const msgId = "msg_test4b";
    const timestamp = new Date(Date.now() + 6 * 60 * 1000);
    const sig = signPayload(TEST_SECRET, msgId, timestamp, payload);
    expect(() =>
      verifyQuoSignature(payload, buildHeaders(msgId, timestamp, sig), TEST_SECRET),
    ).toThrow(/too new/);
  });

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

  const fixture = JSON.parse(readFileSync("fixtures/sample-delivery.json", "utf8")) as {
    headers: Record<string, string>;
    rawBody: string;
  };
  const realSecret = process.env.QUO_WEBHOOK_SECRET;

  // A captured fixture ages out of a literal verifyQuoSignature() replay once its
  // webhook-timestamp is more than 5 minutes old (by design — see 1.8/1.9). So "the real
  // capture verifies" is checked two ways: cryptographic authenticity (independent of
  // wall-clock tolerance, via sign() directly) and that verifyQuoSignature correctly
  // rejects it as stale rather than silently mis-verifying.
  it.skipIf(!realSecret)(
    "the real captured delivery's signature matches what the real secret produces",
    () => {
      const timestamp = new Date(Number(fixture.headers["webhook-timestamp"]) * 1000);
      const expectedSig = new Webhook(realSecret as string).sign(
        fixture.headers["webhook-id"] as string,
        timestamp,
        fixture.rawBody,
      );
      const signatures = (fixture.headers["webhook-signature"] as string).split(" ");
      expect(signatures).toContain(expectedSig);
    },
  );

  it.skipIf(!realSecret)(
    "verifyQuoSignature correctly rejects the real capture once it is outside the 5-minute tolerance",
    () => {
      expect(() =>
        verifyQuoSignature(fixture.rawBody, fixture.headers, realSecret as string),
      ).toThrow(/too old/);
    },
  );
});
