import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    writeFileSync(
      "data/capture-raw.json",
      JSON.stringify(
        {
          headers: req.headers,
          body,
        },
        null,
        2,
      ),
    );
    res.writeHead(200).end();
    console.log("Captured one request to data/capture-raw.json");
    process.exit(0);
  });
}).listen(3000, () => console.log("Listening on :3000"));
