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
