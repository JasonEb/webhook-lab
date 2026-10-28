import "dotenv/config";
import { openDb } from "../src/db/openDb.js";
import { openDeliveryStore } from "../src/db/sqliteDeliveryStore.js";
import { createQuoApiClient } from "../src/quoApiClient.js";
import { runReconciler } from "../src/reconciler.js";

function parseArgs(argv: string[]): { apply: boolean; webhookId: string; db: string } {
  const apply = argv.includes("--apply");
  const webhookIdIdx = argv.indexOf("--webhook-id");
  const webhookId = webhookIdIdx >= 0 ? argv[webhookIdIdx + 1] : process.env.QUO_WEBHOOK_ID;
  const dbIdx = argv.indexOf("--db");
  const db = dbIdx >= 0 ? (argv[dbIdx + 1] as string) : "data/dev.sqlite";
  if (!webhookId) {
    throw new Error("Pass --webhook-id <id> or set QUO_WEBHOOK_ID");
  }
  return { apply, webhookId, db };
}

async function main(): Promise<void> {
  const { apply, webhookId, db: dbPath } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY is not set");

  const db = openDb(dbPath);
  const store = openDeliveryStore(db);
  const client = createQuoApiClient(apiKey);

  const localWebhookIds = new Set(store.listRecent(100_000).map((r) => r.webhookId));

  const result = await runReconciler(client, webhookId, localWebhookIds, {
    apply,
    pacingMs: 750,
  });

  console.log(`${apply ? "LIVE RUN" : "DRY RUN"} — ${result.candidates.length} candidate(s) found`);
  for (const c of result.candidates) {
    console.log(`  ${c.deliveryId}  eventId=${c.eventId}  type=${c.eventType}  quoStatus=${c.quoStatus}`);
  }
  if (apply) {
    console.log(`Retried ${result.retried.length} of ${result.candidates.length} candidate(s).`);
  } else if (result.candidates.length > 0) {
    console.log("Re-run with --apply to actually retry these.");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
