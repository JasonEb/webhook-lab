import type { DeliveryStore } from "./db/DeliveryStore.js";

export interface WorkerConfig {
  leaseMs: number;
  maxAttempts: number;
  now: () => Date;
  random: () => number; // 0..1, injectable for deterministic jitter in tests
}

export type Dispatch = (eventType: string, payload: unknown) => Promise<void>;

export function computeBackoffMs(attempts: number, random: () => number): number {
  const base = Math.min(1000 * 2 ** (attempts - 1), 60000);
  return base + Math.floor(random() * 250);
}

export async function runOnce(
  store: DeliveryStore,
  dispatch: Dispatch,
  config: WorkerConfig,
): Promise<"processed" | "empty"> {
  const claimed = store.claim(config.now(), config.leaseMs);
  if (!claimed) return "empty";

  const startedAt = config.now();
  try {
    const payload = JSON.parse(claimed.payload);
    await dispatch(claimed.eventType, payload);
    store.markDone(claimed.webhookId);
    console.log(
      JSON.stringify({
        event: "worker",
        webhook_id: claimed.webhookId,
        event_type: claimed.eventType,
        attempts: claimed.attempts,
        outcome: "done",
        duration_ms: config.now().getTime() - startedAt.getTime(),
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const backoffMs = computeBackoffMs(claimed.attempts, config.random);
    store.markFailed({
      webhookId: claimed.webhookId,
      now: config.now(),
      attempts: claimed.attempts,
      maxAttempts: config.maxAttempts,
      backoffMs,
      error,
    });
    console.warn(
      JSON.stringify({
        event: "worker",
        webhook_id: claimed.webhookId,
        event_type: claimed.eventType,
        attempts: claimed.attempts,
        outcome: claimed.attempts >= config.maxAttempts ? "dead" : "pending",
        error,
        duration_ms: config.now().getTime() - startedAt.getTime(),
      }),
    );
  }
  return "processed";
}

export function startWorkerLoop(
  store: DeliveryStore,
  dispatch: Dispatch,
  config: WorkerConfig,
  pollMs: number,
): () => void {
  const interval = setInterval(() => {
    runOnce(store, dispatch, config).catch((err: unknown) => {
      console.error("worker loop error", err);
    });
  }, pollMs);
  return () => clearInterval(interval);
}
