#!/usr/bin/env node
// Deterministic fake dext for agentlinkd protocol tests. It implements the
// catalog discovery commands and the one-shot stream-json argv contract.

import fs from "node:fs";
import path from "node:path";

// Provider auth is a file in DEXT_HOME so login/logout survive across the
// one-shot invocations the host makes (status → login → status).
const AUTH_FILE = path.join(process.env.DEXT_HOME ?? "/nonexistent", "fake-auth.json");
function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); } catch { return { "fake-a": "auth" }; }
}
function writeAuth(a) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a));
}

if (process.argv[2] === "auth" && process.argv[3] === "models") {
  const catalog = path.join(process.env.DEXT_HOME ?? "/nonexistent", "fake-models.json");
  if (fs.existsSync(catalog)) {
    process.stdout.write(fs.readFileSync(catalog, "utf8"));
    process.exit(0);
  }
  process.stdout.write(
    "* provider 'fake-a' models:\n- alpha\n- alpha-pro\n\n  provider 'fake-b' models:\n- beta\n",
  );
  process.exit(0);
}
if (process.argv[2] === "auth" && (process.argv[3] === "status" || process.argv[3] === "providers")) {
  const a = readAuth();
  process.stdout.write(
    `active provider: fake-a\n* fake-a Fake A model=alpha contract=fake api=fake spec=model auth=${a["fake-a"] ?? "none"} base=http://fake\n  fake-b Fake B model=beta contract=fake api=fake spec=model auth=${a["fake-b"] ?? "None."} base=http://fake\n  fake-c Fake C model=gamma contract=fake api=fake spec=model auth=sk-fake-9f2a7b1c3d4e base=http://fake\n`,
  );
  process.exit(0);
}
if (process.argv[2] === "auth" && process.argv[3] === "login") {
  const [, , , , provider, credential] = process.argv;
  if (!["fake-a", "fake-b"].includes(provider)) { process.stderr.write(`[err] unknown provider ${provider}\n`); process.exit(1); }
  const a = readAuth();
  a[provider] = "key";
  writeAuth(a);
  process.stdout.write(`stored credential for ${provider} (${credential ? credential.length : 0} chars)\nactive -> fake-a\n`);
  process.exit(0);
}
if (process.argv[2] === "auth" && process.argv[3] === "logout") {
  const a = readAuth();
  delete a[process.argv[4]];
  writeAuth(a);
  process.stdout.write(`removed credential for ${process.argv[4]}\n`);
  process.exit(0);
}
// `dext pack list --verbose` shape (see packs.rs render_pack_listing_opts).
// Paths come from FAKE_PACKS_ROOT so tests can plant PACK.md files.
if (process.argv[2] === "pack" && (process.argv[3] === "list" || process.argv[3] === undefined)) {
  const root = process.env.FAKE_PACKS_ROOT || "/nonexistent";
  process.stdout.write(
    `Packs  3 found\n  hello-chart\n    Emit one interactive chart fence.\n    source: user:${root}/samples\n    shelf: samples\n    path: ${root}/samples/packs/hello-chart\n\n` +
    `  report\n    Generate self-contained interactive HTML5 reports from a\n    small JSON spec.\n    source: user:${root}/research\n    shelf: research\n    path: ${root}/research/packs/report\n\n` +
    `  mesh\n    Peer-to-peer mailbox.\n    source: user:${root}/orchestration\n    shelf: orchestration\n    path: ${root}/orchestration/packs/mesh\n`,
  );
  process.exit(0);
}
if (process.argv[2] === "pack" && process.argv[3] === "inspect") {
  process.stdout.write(`pack ${process.argv[4]}\n  fake inspect output\n`);
  process.exit(0);
}
if (process.argv[2] === "pack" && process.argv[3] === "create") {
  process.stdout.write(`created pack: /fake/${process.argv[4]}\nnext: edit /fake/${process.argv[4]}/PACK.md\n`);
  process.exit(0);
}

if (process.argv[2] === "--help") {
  // Answers the host's bridge probe. `--input ndjson` is advertised only when
  // the test opts in, so default harness runs stay on the one-shot path.
  process.stdout.write(
    `usage: dext [options]\n  -p <prompt>\n${process.env.FAKE_DEXT_NDJSON === "1" ? "  --input ndjson\n" : ""}`,
  );
  process.exit(0);
}

// Persistent host-protocol mode (`--input ndjson`): mirrors the frames the
// bridge patch speaks. Turn scripts: text containing "APPROVE" pauses on a
// permission until a permission frame answers; "SLOW" holds the turn open so
// mid-turn steering can land; pid rides on turn_start so tests can observe
// child recycles. Never returns: exits via close frame or stdin EOF.
if (process.argv.includes("--input") && process.argv[process.argv.indexOf("--input") + 1] === "ndjson") {
  const out = (event, data) => process.stdout.write(JSON.stringify({ event, ...(data === undefined ? {} : { data }) }) + "\n");
  const usage = { input: 3, output: 2, cache_create: 0, cache_read: 0, cost_usd: 0 };
  // `--resume` (seat's latest) or `--resume=<path>` (explicit, after a folder
  // change); echoed on turn_start so host tests can assert the argv contract.
  const resumeArg = process.argv.find((a) => a === "--resume" || a.startsWith("--resume=")) ?? null;
  const resume = resumeArg === null ? null : resumeArg === "--resume" ? "latest" : resumeArg.slice("--resume=".length);
  out("ready", { input: "ndjson", session_id: "fake-ndjson-1", model: process.env.DEXT_MODEL || "alpha", provider: process.env.DEXT_PROVIDER || "fake-a" });
  let busy = false;
  let buf = "";
  const endTurn = (failed = false) => {
    out("usage_update", { turn: usage, session: usage });
    out("turn_end", { usage, failed });
    busy = false;
  };
  const runTurn = (text) => {
    busy = true;
    out("turn_start", { pid: process.pid, resume });
    if (text.includes("APPROVE")) {
      out("permission_request", { id: "perm-1", tool: "write_file", input: { path: "x" }, summary: "" });
      return;
    }
    setTimeout(() => {
      out("text_block_complete", `fake ${text.trim()}`);
      out("thinking_effort_changed", { effort: "high" });
      endTurn(false);
    }, text.includes("SLOW") ? 500 : 60);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      let f;
      try {
        f = JSON.parse(buf.slice(0, i));
      } catch {
        buf = buf.slice(i + 1);
        continue;
      }
      buf = buf.slice(i + 1);
      if (f.type === "user") runTurn(String(f.text ?? ""));
      else if (f.type === "steer") out("steering_received", { messages: [f.text], preview: String(f.text).slice(0, 80) });
      else if (f.type === "permission") {
        out("permission_resolved", { id: f.id, tool: "write_file", choice: f.choice });
        endTurn(false);
      } else if (f.type === "interrupt") {
        if (busy) endTurn(true);
      } else if (f.type === "close") process.exit(0);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  await new Promise(() => {});
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
const resumed = process.argv.some((a) => a === "--resume" || a.startsWith("--resume="));
const packAt = process.argv.indexOf("--pack");
const pack = packAt >= 0 ? process.argv[packAt + 1] : null;
const partial = prompt.includes("partial-stream");
const text = `fake ${prompt.trim()}${resumed ? " [resumed]" : ""}${pack ? ` [pack=${pack}]` : ""} [${provider}/${model}; effort=${effort}]`;
if (partial) {
  emit("warn", "provider closed the stream after partial text; preserved partial response instead of replaying the same turn");
}
emit("text_block_complete", text);
if (pack) emit("runtime_view", { pack, title: `${pack} result`, markdown: `ran **${pack}**` });
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
