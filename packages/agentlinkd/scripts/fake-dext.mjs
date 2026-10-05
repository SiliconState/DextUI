#!/usr/bin/env node
// Deterministic fake dext for agentlinkd protocol tests. It implements the
// catalog discovery commands and the one-shot stream-json argv contract.

import fs from "node:fs";
import path from "node:path";

// Provider auth is a file in DEXT_HOME so login/logout survive across the
// one-shot invocations the host makes (status → login → status).
const AUTH_FILE = path.join(process.env.DEXT_HOME ?? "/nonexistent", "fake-auth.json");
const AUTH_FAILURE_FILE = path.join(process.env.DEXT_HOME ?? "/nonexistent", "fake-auth-failure");
if (process.argv[2] === "auth" && fs.existsSync(AUTH_FAILURE_FILE)) {
  const mode = fs.readFileSync(AUTH_FAILURE_FILE, "utf8").trim();
  if (mode === "empty" && ["status", "models"].includes(process.argv[3])) { console.log(JSON.stringify({ version: 1, active_provider: "fake-a", providers: [] })); process.exit(0); }
  process.stderr.write(`Error: provider state has unsafe writable mode 0664; remove group/world write bits: ${process.env.DEXT_HOME}/providers.json fixture-secret-must-not-echo\n`);
  process.exit(1);
}
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
  const [, , , , provider] = process.argv;
  let credential = "";
  for await (const chunk of process.stdin) credential += chunk;
  credential = credential.trim();
  if (!credential) { process.stderr.write("[err] missing credential on stdin\n"); process.exit(1); }
  if (!["fake-a", "fake-b"].includes(provider)) { process.stderr.write(`[err] unknown provider ${provider}\n`); process.exit(1); }
  const a = readAuth();
  a[provider] = "key";
  writeAuth(a);
  if (process.env.FAKE_DEXT_AUTH_POST_LOGIN_FAIL === "1") fs.writeFileSync(AUTH_FAILURE_FILE, "mode");
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
    `usage: dext [options]\n  -p <prompt>\n${process.env.FAKE_DEXT_BACKGROUND_SETTING === "1" ? "  --background-compact=on|off\n" : ""}${process.env.FAKE_DEXT_NDJSON === "1" ? "  --input ndjson (ui.capabilities ui.response; emits ui.request)\n" : ""}`,
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
  let backgroundEnabled = process.argv.find((arg) => arg.startsWith("--background-compact="))?.slice("--background-compact=".length) !== "off";
  if (process.env.FAKE_DEXT_PRE_READY_BACKGROUND === "1") out("background_compaction_setting", { enabled: !backgroundEnabled });
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DEXT_READY_DELAY_MS) || 0));
  out("ready", {
    input: "ndjson",
    session_id: "fake-ndjson-1",
    model: process.env.DEXT_MODEL || "alpha",
    provider: process.env.DEXT_PROVIDER || "fake-a",
    ...(process.env.FAKE_DEXT_BACKGROUND_SETTING === "1" ? { background_compact: backgroundEnabled } : {}),
    ui_protocol: 1,
    frames: ["user", "steer", "control", "interrupt", "permission", "ui.capabilities", "ui.response", "close"],
  });
  let busy = false;
  let uiMethods = [];
  let waitingUi = null;
  let rejectUiOnce = false;
  let buf = "";
  let turnTimer = null;
  let sessionUsage = usage;
  let bg = null, lastBg = null, nextBg = 0;
  const bgEvent = (phase, job = bg) => {
    if (job) out("background_compaction", { ...job, phase, blocking: phase === "waiting" });
  };
  const endTurn = (failed = false) => {
    clearTimeout(turnTimer);
    turnTimer = null;
    out("usage_update", { turn: usage, session: sessionUsage });
    out("turn_end", { usage: sessionUsage, failed });
    busy = false;
  };
  const runTurn = (text) => {
    busy = true;
    out("turn_start", { pid: process.pid, resume });
    if (text.includes("BG_") && backgroundEnabled) {
      if (text.includes("BG_START")) {
        bg = { version: 1, session_id: "fake-ndjson-1", session_epoch: 0, job_id: `bg-fake-${++nextBg}`, origin_turn_id: "fake-turn", reason: "fixture", elapsed_ms: 10, wait_ms: 0, before_chars: 25000, usage_known: true };
        bgEvent("running");
      }
      if (text.includes("BG_WAIT")) bgEvent("waiting");
      if (text.includes("BG_APPLY") && bg) {
        bgEvent("ready");
        sessionUsage = { ...usage, input: 14, output: 9 };
        out("usage_update", { turn: usage, session: sessionUsage });
        out("history_context_updated", { chars: 1000, tokens: 250 });
        out("compact_end", { before: 12, after: 3, summary: "Background fixture summary", background: true, job_id: bg.job_id });
        bgEvent("applied");
        lastBg = bg; bg = null;
      }
      if (text.includes("BG_STALE")) bgEvent("ready", lastBg);
      out("text_block_complete", `fake ${text.trim()}`);
      endTurn(false);
      return;
    }
    if (text.includes("UI_FORM")) {
      if (!uiMethods.includes("form") || !uiMethods.includes("progress")) {
        out("error", "host did not advertise pack UI methods");
        endTurn(true);
        return;
      }
      waitingUi = "ui-progress-1";
      out("ui.request", { id: waitingUi, pack: "fake-pack", request_id: "progress-1", method: "progress", params: { id: "work", title: "Preparing form", message: "Loading choices", current: 1, total: 2, state: "running" } });
      return;
    }
    if (text.includes("UI_REJECT")) {
      if (!uiMethods.includes("form")) {
        out("error", "host did not advertise pack UI methods");
        endTurn(true);
        return;
      }
      waitingUi = "ui-form-reject";
      rejectUiOnce = true;
      out("ui.request", { id: waitingUi, pack: "fake-pack", request_id: "reject", method: "form", params: { title: "Retry form", fields: [{ id: "name", label: "Name", type: "text" }] } });
      return;
    }
    if (text.includes("IMAGE_APPROVE")) {
      out("tool_call_start", { call_id: "image-1", name: "read_image", summary: "read_image: uploads/shot.png (pixels will be sent to the model provider)" });
      out("permission_request", { id: "image-perm-1", tool: "read_image", input: { path: "uploads/shot.png" }, summary: '{"path":"uploads/shot.png"}' });
      return;
    }
    if (text.includes("APPROVE")) {
      out("permission_request", { id: "perm-1", tool: "write_file", input: { path: "x" }, summary: "" });
      return;
    }
    turnTimer = setTimeout(() => {
      out("text_block_complete", `fake ${text.trim()}`);
      out("thinking_effort_changed", { effort: "high" });
      endTurn(false);
    }, Number(process.env.FAKE_DEXT_TURN_DELAY_MS) || (text.includes("SLOW") ? 500 : 60));
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
      const ack = (route, detail) => out("input_ack", { type: String(f.type ?? ""), route, seq: f.seq ?? null, ...(detail ? { detail } : {}) });
      if (f.type === "ui.capabilities") {
        uiMethods = Array.isArray(f.methods) ? f.methods : [];
        ack("ui_capabilities_set");
      }
      else if (f.type === "ui.response") {
        if (f.id === "ui-form-reject" && rejectUiOnce) {
          rejectUiOnce = false;
          ack("invalid", "UI response queue full or closed");
          continue;
        }
        if (f.id !== waitingUi) {
          ack("invalid", "ui.response: id is stale or already answered");
          continue;
        }
        ack("ui_response_forwarded");
        if (f.id === "ui-progress-1") {
          waitingUi = "ui-form-1";
          out("ui.request", {
            id: waitingUi,
            pack: "fake-pack",
            request_id: "profile",
            method: "form",
            params: {
              title: "Profile",
              description: "Tell the fake pack what to use.",
              submit_label: "Continue",
              fields: [
                { id: "name", label: "Name", type: "text", required: true, placeholder: "Ada" },
                { id: "notes", label: "Notes", type: "textarea" },
                { id: "count", label: "Count", type: "number", default: 2 },
                { id: "confirm", label: "Confirm", type: "boolean" },
                { id: "color", label: "Color", type: "select", options: ["blue", "green"] },
                { id: "tags", label: "Tags", type: "multiselect", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
              ],
            },
          });
        } else {
          waitingUi = null;
          out("text_block_complete", f.status === "ok" ? "fake pack received the form" : "fake pack form cancelled");
          endTurn(false);
        }
      }
      else if (f.type === "user") { ack("submitted"); runTurn(String(f.text ?? "")); }
      else if (f.type === "steer") { ack("steering_queued"); out("steering_received", { messages: [f.text], preview: String(f.text).slice(0, 80) }); }
      else if (f.type === "control" && String(f.command ?? "").startsWith("/compact")) {
        const command = String(f.command ?? "");
        if (command.startsWith("/compact background")) {
          if (busy || process.env.FAKE_DEXT_BACKGROUND_REFUSE === "1" && !command.endsWith("status")) { ack("unsupported_busy_slash", "fixture setting refused"); continue; }
          if (process.env.FAKE_DEXT_BACKGROUND_EXIT === "1") process.exit(1);
          ack("submitted");
          setTimeout(() => {
            if (!command.endsWith("status")) {
              const next = command.endsWith("on");
              if (!next) { bgEvent("cancelled"); lastBg = bg; bg = null; }
              if (process.env.FAKE_DEXT_BACKGROUND_FAIL === "1") { backgroundEnabled = backgroundEnabled && next; out("error", "[background compaction] persisting background compaction setting: fixture save failed"); return; }
              backgroundEnabled = next;
            }
            out("background_compaction_setting", { enabled: backgroundEnabled });
            out("info", `background compaction: ${backgroundEnabled ? "on" : "off"}; regular compaction remains available`);
          }, Number(process.env.FAKE_DEXT_BACKGROUND_DELAY_MS) || 0);
          continue;
        }
        ack("runtime_control_queued");
        if (command === "/compact") {
          bgEvent("cancelled"); lastBg = bg; bg = null;
          setTimeout(() => out("compact_start"), 20);
          setTimeout(() => out("history_context_updated", { chars: 4800, tokens: 1200 }), 70);
          setTimeout(() => out("compact_end", {
            before: 48,
            after: 11,
            summary: "Task\nKeep the current objective, decisions, changed files, verification, and open work.",
          }), 90);
        } else {
          out("slash", `compact setting: ${command.slice(9)}`);
        }
      }
      else if (f.type === "permission") {
        ack("permission_forwarded");
        const image = f.id === "image-perm-1";
        out("permission_resolved", { id: f.id, tool: image ? "read_image" : "write_file", choice: f.choice });
        if (image && f.choice !== "deny") {
          out("tool_call_result", {
            call_id: "image-1",
            name: "read_image",
            ok: true,
            preview: "read_image: uploads/shot.png (pixels will be sent to the model provider)",
            content: "approved image uploads/shot.png (1x1, sanitized as image/jpeg); pixels are available to the model only in this turn",
          });
        }
        endTurn(false);
      } else if (f.type === "interrupt") {
        ack("interrupted");
        bgEvent("cancelled"); lastBg = bg; bg = null;
        if (busy) endTurn(true);
      } else if (f.type === "close") { ack("close"); process.exit(0); }
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

emit("turn_start", { pid: process.pid });
await sleep(Number(process.env.FAKE_DEXT_TURN_DELAY_MS) || 180);
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
