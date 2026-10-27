import express, { type Request, type Response } from "express";
import { verifyQuoSignature, SignatureVerificationError } from "./verifyQuoSignature.js";
import { logArrival, logRejection, getArrivalCounters } from "./arrivalLog.js";
import type { DeliveryStore } from "./db/DeliveryStore.js";

export function createApp(store: DeliveryStore, secret: string) {
  const app = express();

  app.post(
    "/webhooks/quo",
    express.raw({ type: "application/json" }),
    (req: Request, res: Response) => {
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

      const result = store.insertIfNew({
        webhookId: parsed.id,
        eventType: parsed.type,
        payload: rawBody.toString("utf8"),
        receivedAt: new Date().toISOString(),
      });

      logArrival({
        webhookId: parsed.id,
        eventType: parsed.type,
        outcome: result === "inserted" ? "accepted" : "duplicate",
      });

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
