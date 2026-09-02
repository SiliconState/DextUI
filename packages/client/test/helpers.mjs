// Shared helpers for @dextui/client tests. Zero dependencies (Node 22 node:test).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, "..", "..", "mock-server", "fixtures");

export const SESSION = "sess_t";

/** Wrap one raw `{event,data}` line as an AgentLink data envelope, exactly like the hosts do. */
export function envelope(i, line) {
  const env = { v: 1, session: SESSION, seq: i + 1, ts: 1000 + i, event: line.event };
  if (line.data !== undefined) env.data = line.data;
  return env;
}

/** Build a sequenced journal from an inline `[{event,data}]` script. */
export function journal(lines) {
  return lines.map((line, i) => envelope(i, line));
}

/** Read a `.raw.jsonl` fixture (one `{event,data}` per line) as data envelopes. */
export function envelopesFromFixture(file) {
  const p = path.isAbsolute(file) ? file : path.join(FIXTURES_DIR, file);
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return journal(lines);
}

/** List every fixture file name under packages/mock-server/fixtures. */
export function fixtureFiles() {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".raw.jsonl"))
    .sort();
}

/** Drop the client-only `id` stamp so blocks compare against fold.mjs output. */
export function stripIds(blocks) {
  return blocks.map(({ id: _id, ...rest }) => rest);
}

export function applyAll(store, envelopes) {
  for (const e of envelopes) store.apply(e);
  return store;
}
