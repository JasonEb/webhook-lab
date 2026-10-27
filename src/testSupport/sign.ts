import { Webhook } from "svix";

export function signPayload(
  secret: string,
  msgId: string,
  timestamp: Date,
  payload: string,
): string {
  return new Webhook(secret).sign(msgId, timestamp, payload);
}

export function buildHeaders(msgId: string, timestamp: Date, signature: string) {
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": signature,
  };
}

export function buildSignedHeaders(secret: string, msgId: string, payload: string) {
  const timestamp = new Date();
  const sig = signPayload(secret, msgId, timestamp, payload);
  return buildHeaders(msgId, timestamp, sig);
}
