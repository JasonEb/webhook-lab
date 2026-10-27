import express, { type Request, type Response } from "express";
import { verifyQuoSignature, SignatureVerificationError } from "./verifyQuoSignature.js";
import { logArrival, logRejection, getArrivalCounters } from "./arrivalLog.js";
import { decideFault, type FaultMode } from "./faultInjector.js";
import type { DeliveryStore } from "./db/DeliveryStore.js";
import type { ArrivalStore } from "./db/arrivalStore.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateAppOptions {
  store: DeliveryStore;
  arrivalStore: ArrivalStore;
  secret: string;
  faultMode?: FaultMode;
  label?: string;
}

export function createApp(options: CreateAppOptions) {
  const { store, arrivalStore, secret } = options;
  const faultMode: FaultMode = options.faultMode ?? { type: "none" };
  const label = options.label ?? null;
  const app = express();

  app.post(
    "/webhooks/quo",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const rawBody = req.body as Buffer;

      try {
        verifyQuoSignature(rawBody, req.headers, secret);
      } catch (err) {
        if (err instanceof SignatureVerificationError) {
          logRejection({ reason: "bad_signature" });
          res.status(401).end();
          return;
        }
        throw err;
      }

      let parsed: { id: string; type: string };
      try {
        parsed = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string };
      } catch {
        logRejection({ reason: "malformed_json" });
        res.status(400).end();
        return;
      }

      const receivedAt = new Date().toISOString();
      const tsHeader = (req.headers["webhook-timestamp"] as string | undefined) ?? "";
      const priorCount = arrivalStore.countForWebhookId(parsed.id);
      const decision = decideFault(faultMode, priorCount);

      if (decision.delayMs > 0) {
        await sleep(decision.delayMs);
      }

      if (decision.statusCode !== null) {
        arrivalStore.record({
          webhookId: parsed.id,
          eventType: parsed.type,
          receivedAt,
          tsHeader,
          outcome: "faulted",
          label,
        });
        logArrival({ webhookId: parsed.id, eventType: parsed.type, outcome: "faulted" });
        res.status(decision.statusCode).end();
        return;
      }

      const result = store.insertIfNew({
        webhookId: parsed.id,
        eventType: parsed.type,
        payload: rawBody.toString("utf8"),
        receivedAt,
      });

      const outcome = result === "inserted" ? "accepted" : "duplicate";
      arrivalStore.record({
        webhookId: parsed.id,
        eventType: parsed.type,
        receivedAt,
        tsHeader,
        outcome,
        label,
      });
      logArrival({ webhookId: parsed.id, eventType: parsed.type, outcome });

      res.status(200).end();
    },
  );

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/debug/deliveries", (_req: Request, res: Response) => {
    res.status(200).json(store.listRecent(50));
  });

  app.get("/debug/stats", (_req: Request, res: Response) => {
    res.status(200).json({
      deliveries: store.countsByStatus(),
      arrivals: getArrivalCounters(),
    });
  });

  return app;
}
