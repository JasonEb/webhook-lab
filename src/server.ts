import "dotenv/config";
import { createApp } from "./app.js";
import { openDb } from "./db/openDb.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";
import { openDomainStore } from "./db/domainStore.js";
import { openArrivalStore } from "./db/arrivalStore.js";
import { makeDispatchHandler } from "./handlers/index.js";
import { startWorkerLoop } from "./worker.js";
import { parseFaultMode, logFaultModeWarningIfActive } from "./faultInjector.js";

const secret = process.env.QUO_WEBHOOK_SECRET;
if (!secret) {
  throw new Error("QUO_WEBHOOK_SECRET is not set");
}

const faultMode = parseFaultMode(process.env.FAULT_MODE);
logFaultModeWarningIfActive(faultMode);

const db = openDb("data/dev.sqlite");
const store = openDeliveryStore(db);
const domainStore = openDomainStore(db);
const arrivalStore = openArrivalStore(db);
const app = createApp({
  store,
  arrivalStore,
  secret,
  faultMode,
  label: process.env.EXPERIMENT_LABEL,
});
const port = Number(process.env.PORT ?? 3000);

const stopWorker = startWorkerLoop(
  store,
  makeDispatchHandler(domainStore),
  {
    leaseMs: 30_000,
    maxAttempts: 5,
    now: () => new Date(),
    random: () => Math.random(),
  },
  500,
);

const server = app.listen(port, () => console.log(`Listening on :${port}`));

process.on("SIGINT", () => {
  stopWorker();
  server.close(() => process.exit(0));
});
