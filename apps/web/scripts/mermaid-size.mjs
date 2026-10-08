// Audit actual browser demand-loads against the built assets, not the sum of
// every optional family emitted to disk. Run after mermaid-review-test.sh.
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
const [directory = "apps/web/dist", logFile = "/tmp/dextui-mermaid-probe.log"] = process.argv.slice(2);
const lines = fs.readFileSync(logFile, "utf8").split("\n");
const line = lines.find(line => line.includes("firstDiagramAssets"));
if (!line) throw new Error("No first-diagram asset trace in review log");
let record = JSON.parse(line);
if (typeof record === "string") record = JSON.parse(record);
let total = 0;
for (const url of record.firstDiagramAssets) {
  const filename = path.basename(new URL(url).pathname);
  if (!filename.endsWith(".js") || filename.startsWith("index-")) continue;
  // Review entry and production hashes can differ; match the stable chunk name.
  const stem = /^(.*)-[\w-]{8}\.js$/.exec(filename)?.[1];
  if (!stem) throw new Error(`Unrecognized chunk filename: ${filename}`);
  const production = fs.readdirSync(path.join(directory, "assets")).find(file => file === filename || file.startsWith(stem + "-") && file.endsWith(".js"));
  if (!production) throw new Error(`Missing built chunk: ${filename}`);
  const bytes = gzipSync(fs.readFileSync(path.join(directory, "assets", production))).length;
  total += bytes;
  console.log(`${production}: ${(bytes / 1024).toFixed(1)} KiB gzip`);
}
console.log(`First flowchart: ${(total / 1024).toFixed(1)} KiB gzip deferred; zero Mermaid engine bytes for plain chat`);
if (total > 300 * 1024) throw new Error("First flowchart demand-load exceeds the 300 KiB budget");
