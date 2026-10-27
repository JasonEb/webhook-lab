import { writeFileSync } from "node:fs";
import { openDb } from "../src/db/openDb.js";
import { openArrivalStore, type ArrivalRow } from "../src/db/arrivalStore.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args[key] = value;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

function bucket(gapMs: number): string {
  if (gapMs < 1000) return "<1s";
  if (gapMs < 5000) return "1-5s";
  if (gapMs < 30000) return "5-30s";
  return ">30s";
}

function toCsv(rows: ArrivalRow[]): string {
  const header = "webhook_id,event_type,received_at,ts_header,outcome,label";
  const lines = rows.map((r) =>
    [r.webhookId, r.eventType, r.receivedAt, r.tsHeader, r.outcome, r.label ?? ""].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db ?? "data/dev.sqlite";
  const db = openDb(dbPath);
  const arrivalStore = openArrivalStore(db);

  const rows = arrivalStore.listAll({
    sinceIso: args.since,
    label: args.label,
  });

  if (rows.length === 0) {
    console.log("No matching arrivals.");
    return;
  }

  const byWebhookId = new Map<string, ArrivalRow[]>();
  for (const row of rows) {
    const list = byWebhookId.get(row.webhookId) ?? [];
    list.push(row);
    byWebhookId.set(row.webhookId, list);
  }

  const allGaps: number[] = [];

  for (const [webhookId, group] of byWebhookId) {
    console.log(`\n${webhookId} (${group[0]?.eventType}) — ${group.length} arrival(s)`);
    let prevTs: number | null = null;
    for (const row of group) {
      const ts = new Date(row.receivedAt).getTime();
      const gap = prevTs !== null ? ts - prevTs : null;
      if (gap !== null) allGaps.push(gap);
      console.log(
        `  ${row.receivedAt}  ${row.outcome.padEnd(9)}` +
          (gap !== null ? `  +${gap}ms (${bucket(gap)})` : "  (first)"),
      );
      prevTs = ts;
    }
  }

  console.log(`\n--- Aggregate across ${byWebhookId.size} webhook_id(s), ${rows.length} arrival(s) ---`);
  if (allGaps.length > 0) {
    const min = Math.min(...allGaps);
    const max = Math.max(...allGaps);
    const mean = allGaps.reduce((a, b) => a + b, 0) / allGaps.length;
    console.log(`Gaps: min ${min}ms, max ${max}ms, mean ${Math.round(mean)}ms`);
    const buckets: Record<string, number> = {};
    for (const g of allGaps) {
      const b = bucket(g);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    console.log("Gap distribution:", buckets);
  } else {
    console.log("No inter-arrival gaps (every webhook_id arrived exactly once).");
  }

  const outcomeCounts: Record<string, number> = {};
  for (const row of rows) {
    outcomeCounts[row.outcome] = (outcomeCounts[row.outcome] ?? 0) + 1;
  }
  console.log("Outcome counts:", outcomeCounts);

  if (args.csv) {
    writeFileSync(args.csv, toCsv(rows));
    console.log(`\nWrote ${rows.length} rows to ${args.csv}`);
  }
}

main();
