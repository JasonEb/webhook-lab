import "dotenv/config";
import { createApp } from "./app.js";
import { openDeliveryStore } from "./db/sqliteDeliveryStore.js";

const secret = process.env.QUO_WEBHOOK_SECRET;
if (!secret) {
  throw new Error("QUO_WEBHOOK_SECRET is not set");
}

const store = openDeliveryStore("data/dev.sqlite");
const app = createApp(store, secret);
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => console.log(`Listening on :${port}`));
