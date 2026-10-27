import "dotenv/config";
import { createApp } from "./app.js";
import { openDb } from "./db/openDb.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";
import { openDomainStore } from "./db/domainStore.js";
import { makeDispatchHandler } from "./handlers/index.js";
import { startWorkerLoop } from "./worker.js";

const secret = process.env.QUO_WEBHOOK_SECRET;
if (!secret) {
  throw new Error("QUO_WEBHOOK_SECRET is not set");
}

const db = openDb("data/dev.sqlite");
const store = openDeliveryStore(db);
const domainStore = openDomainStore(db);
const app = createApp(store, secret);
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
