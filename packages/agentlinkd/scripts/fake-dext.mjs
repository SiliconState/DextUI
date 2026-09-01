#!/usr/bin/env node
// Deterministic fake dext for agentlinkd protocol tests. It implements the
// catalog discovery commands and the one-shot stream-json argv contract.

if (process.argv[2] === "auth" && process.argv[3] === "models") {
  process.stdout.write(
    "* provider 'fake-a' models:\n- alpha\n- alpha-pro\n\n  provider 'fake-b' models:\n- beta\n",
  );
  process.exit(0);
}
if (process.argv[2] === "auth" && (process.argv[3] === "status" || process.argv[3] === "providers")) {
  process.stdout.write(
    "active provider: fake-a\n* fake-a Fake A model=alpha contract=fake api=fake spec=model auth=auth base=http://fake\n  fake-b Fake B model=beta contract=fake api=fake spec=model auth=auth base=http://fake\n",
  );
  process.exit(0);
}

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
const effortAt = process.argv.indexOf("--effort");
const effort = effortAt >= 0 ? process.argv[effortAt + 1] : "medium";
const provider = process.env.DEXT_PROVIDER || "fake-a";
const model = process.env.DEXT_MODEL || "alpha";

emit("turn_start");
await sleep(180);
emit("text_delta", "fake ");
await sleep(180);
const resumed = process.argv.includes("--resume");
const partial = prompt.includes("partial-stream");
const text = `fake ${prompt.trim()}${resumed ? " [resumed]" : ""} [${provider}/${model}; effort=${effort}]`;
if (partial) {
  emit("warn", "provider closed the stream after partial text; preserved partial response instead of replaying the same turn");
}
emit("text_block_complete", text);
emit("thinking_effort_changed", { effort });
emit("usage_update", { turn: usage, session: usage });
emit("turn_diagnostics", {
  provider,
  api_family: "fake",
  auth_source: "none",
  model,
  context_window: 1000,
  last_retry_reason: null,
  workaround_fired: false,
});
emit("turn_end", { usage, failed: false });
