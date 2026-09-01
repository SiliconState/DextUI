#!/usr/bin/env node
// Deterministic fake dext for agentlinkd protocol tests. It accepts dext's
// one-shot argv shape, reads a prompt from stdin, and emits stream-json.

const prompt = await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => resolve(s));
});

const emit = (event, data) => {
  const v = { event };
  if (data !== undefined) v.data = data;
  process.stdout.write(JSON.stringify(v) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = { input: 3, output: 2, cache_create: 0, cache_read: 0, cost_usd: 0 };

emit("turn_start");
await sleep(180);
emit("text_delta", "fake ");
await sleep(180);
const resumed = process.argv.includes("--resume");
const text = `fake ${prompt.trim()}${resumed ? " [resumed]" : ""}`;
emit("text_block_complete", text);
emit("usage_update", { turn: usage, session: usage });
emit("turn_diagnostics", {
  provider: "fake",
  api_family: "fake",
  auth_source: "none",
  model: "fake-test",
  context_window: 1000,
  last_retry_reason: null,
  workaround_fired: false,
});
emit("turn_end", { usage, failed: false });
