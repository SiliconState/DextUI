// agentlink-mock: zero-dependency reference host for AgentLink v1.
// Serves the REST surface, WebSocket protocol, per-session journals,
// fixture replays, synthetic approvals, and (if built) the PWA statically.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";
import { acceptKey, FrameParser, encodeFrame, OP_PONG, OP_TEXT } from "./ws.mjs";
import { loadFixture, withApprovalPause } from "./replay.mjs";
import { fold, foldMeta } from "./fold.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");

// ---------- args ----------

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const PORT = Number(argValue("port", process.env.MOCK_PORT ?? 8787));
const TOKEN = argValue("token", process.env.MOCK_TOKEN ?? "dev-token");
const APPROVAL_TIMEOUT_MS = Number(argValue("approval-timeout-ms", process.env.MOCK_APPROVAL_TIMEOUT_MS ?? 120000));
const STATIC_DIR = path.resolve(argValue("static", path.join(repoRoot, "apps", "web", "dist")));
const MOCK_MODEL_CATALOG = [
  { provider: "mock", label: "Mock", models: ["mock-echo", "k3-fixture"] },
];
const EFFORT_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORTS = new Set(EFFORT_OPTIONS);
const CAPABILITIES = [
  "approvals",
  "steering",
  "interrupt",
  "slash",
  "slash.help",
  "slash.approval",
  "slash.compact",
  "slash.model",
  "slash.todos",
  "multi_session",
  "usage",
  "thinking",
  "model_select",
  "effort_select",
  "todos_read",
  "session_manage",
  "packs",
  // x-agentlinkd.dirs.{list,create} over an in-memory tree (no filesystem).
  "dirs",
  // x-agentlinkd.flows.* over an in-memory store; run = a synthetic reply.
  "flows",
];

// In-memory flow store so the builder is exercisable without a host on disk.
const MOCK_FLOWS = new Map();

// Fake folder tree for the picker: `hello_ok.home` is /home/demo.
const MOCK_HOME = "/home/demo";
const MOCK_DIRS = new Map([
  [MOCK_HOME, { dirs: ["Books", "Clients", "Projects"], files: 2 }],
  [`${MOCK_HOME}/Books`, { dirs: ["2025", "2026"], files: 3 }],
  [`${MOCK_HOME}/Books/2025`, { dirs: [], files: 12 }],
  [`${MOCK_HOME}/Books/2026`, { dirs: ["Q1", "Q2", "Q3"], files: 4 }],
  [`${MOCK_HOME}/Books/2026/Q1`, { dirs: [], files: 31 }],
  [`${MOCK_HOME}/Books/2026/Q2`, { dirs: [], files: 28 }],
  [`${MOCK_HOME}/Books/2026/Q3`, { dirs: [], files: 9 }],
  [`${MOCK_HOME}/Clients`, { dirs: ["Acme Ltd", "Blue Bakery"], files: 0 }],
  [`${MOCK_HOME}/Clients/Acme Ltd`, { dirs: [], files: 6 }],
  [`${MOCK_HOME}/Clients/Blue Bakery`, { dirs: [], files: 2 }],
  [`${MOCK_HOME}/Projects`, { dirs: ["website"], files: 0 }],
  [`${MOCK_HOME}/Projects/website`, { dirs: [], files: 40 }],
]);

function mockFlowList() {
  return [...MOCK_FLOWS.values()].map((f) => ({ name: f.name, title: f.title ?? f.name, desc: f.desc ?? "", nodes: f.nodes.length, edges: f.edges.length, mtime: Date.now() }));
}

function mockDirsList(requested) {
  const p = typeof requested === "string" && requested.trim() ? (requested.startsWith("/") ? requested : `${MOCK_HOME}/${requested}`) : MOCK_HOME;
  if (p !== MOCK_HOME && !p.startsWith(MOCK_HOME + "/")) return { error: "bad_path" };
  const node = MOCK_DIRS.get(p);
  if (!node) return { error: "no_dir" };
  return { path: p, rel: p === MOCK_HOME ? "" : p.slice(MOCK_HOME.length + 1), parent: p === MOCK_HOME ? null : p.slice(0, p.lastIndexOf("/")), root: MOCK_HOME, dirs: node.dirs.map((name) => ({ name })), files: node.files, truncated: false };
}

// Fake catalog so the gallery, `/` menu, and pack badges are exercisable
// without dext. Shapes match agentlinkd's PackInfo exactly.
const PACKS = [
  { name: "hello-chart", shelf: "samples", description: "Emit one interactive chart fence. Guaranteed sub-10 s artifact.", source: "bundled", path: "/mock/samples/packs/hello-chart",
    ui: { starter_prompt: "Run hello-chart", artifact: "chart", time_to_first_artifact: 3, requires: [], gallery: true, tags: ["sample"], icon: "chart" }, unmet: [] },
  { name: "report", shelf: "research", description: "Generate self-contained interactive HTML5 reports from a small JSON spec.", source: "user:~/.dext/shelves/research", path: "/mock/research/packs/report",
    ui: { starter_prompt: "Summarise this workspace as an HTML report", artifact: "html", time_to_first_artifact: 45, requires: ["approval:auto-write"], gallery: true, tags: ["research"], icon: "report" }, unmet: ["approval:auto-write"] },
  { name: "agent_browser", shelf: "engineering", description: "Headless Chromium automation via the agent-browser CLI.", source: "user:~/.dext/shelves/engineering", path: "/mock/engineering/packs/agent_browser",
    ui: { starter_prompt: "Fetch the title of example.com", artifact: "markdown", time_to_first_artifact: 20, requires: ["chromium"], gallery: true, tags: ["browser"], icon: "browser" }, unmet: ["chromium"] },
  { name: "mesh", shelf: "orchestration", description: "Peer-to-peer mailbox between independent Dext sessions.", source: "user:~/.dext/shelves/orchestration", path: "/mock/orchestration/packs/mesh",
    ui: { starter_prompt: "/pack run mesh ", artifact: "markdown", time_to_first_artifact: 0, requires: [], gallery: false, tags: [], }, unmet: [] },
];

// Host-driven composer completion (mirrors the slash.* caps above).
const COMMANDS = [
  { cmd: "/help", desc: "list host commands" },
  { cmd: "/approval", desc: "set dext approval profile" },
  { cmd: "/compact", desc: "compact session context" },
  { cmd: "/model", desc: "show or switch model" },
  { cmd: "/todos", desc: "show the todo list" },
  ...PACKS.map((p) => ({ cmd: `/pack run ${p.name}`, desc: p.description })),
  { cmd: "/pack list", desc: "list installed packs" },
];

// Random per process so clients detect a restarted host and resync from a
// snapshot instead of splicing a stale seq-resume onto a rebuilt journal.
const INSTANCE = crypto.randomBytes(8).toString("hex");

// ---------- state ----------

let sessionCounter = 0;
let clientCounter = 0;
const sessions = new Map();
const clients = new Set();

function makeSession({ title, fixture, approvalFlow, live }) {
  const id = `sess_${(++sessionCounter).toString().padStart(3, "0")}`;
  const s = {
    id,
    title,
    fixture,
    approvalFlow,
    provider: "mock",
    model: fixture ? "k3-fixture" : "mock-echo",
    thinkingEffort: "medium",
    modelLocked: false,
    // Mirrors agentlinkd's default so the pack approval guard is exercisable
    // in the mock; approval-flow fixtures stay on "ask". `/approval <p>` overrides.
    approvalProfile: approvalFlow ? null : "auto-read",
    turns: 0,
    cwd: "/tmp/scratch",
    status: live ? "live" : "cold",
    working: false,
    turnStartedAt: null,
    createdAt: Date.now(),
    seq: 0,
    generation: 0,
    journal: [],
    pending: new Map(),
    approvalCounter: 0,
    plan: null,
    pos: 0,
    timer: null,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  };
  sessions.set(id, s);
  return s;
}

const seededText = makeSession({ title: "Fixture: text turn", fixture: "text.raw.jsonl", approvalFlow: false, live: false });
const seededTool = makeSession({ title: "Fixture: tool + approval", fixture: "tool.raw.jsonl", approvalFlow: true, live: false });

// ---------- journal + publish ----------

function journalData(s, event, data) {
  const env = { v: 1, session: s.id, seq: ++s.seq, ts: Date.now(), event };
  if (data !== undefined) env.data = data;
  s.journal.push(env);
  return env;
}

function metaOf(s) {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    generation: s.generation,
    agent: { name: "dext-mock", version: "0.1.0" },
    model: s.model,
    provider: s.provider,
    thinking_effort: s.thinkingEffort,
    model_locked: s.modelLocked,
    approval_profile: s.approvalProfile ?? (s.approvalFlow ? "ask" : "always"),
    status: s.status,
    created_at: s.createdAt,
    updated_at: Date.now(),
    last_seq: s.seq,
    unread: 0,
    pending_permissions: s.pending.size,
  };
}

let listTimer = null;
function scheduleList() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg = JSON.stringify({
      v: 1,
      ts: Date.now(),
      event: "session.list",
      data: { sessions: [...sessions.values()].map(metaOf) },
    });
    for (const c of clients) if (c.phase === "live") c.send(msg);
  }, 60);
}

function publish(env) {
  const line = JSON.stringify(env);
  // Never leak session data to sockets that haven't completed hello yet.
  for (const c of clients) if (c.phase === "live" && c.subs.has(env.session)) c.send(line);
  scheduleList();
}

function snapshotEnvelope(s) {
  // Point-in-time projection at the current journal tail; snapshots are not
  // journal entries and therefore do not consume sequence numbers.
  const meta = foldMeta(s.journal);
  return {
    v: 1,
    session: s.id,
    seq: s.seq,
    ts: Date.now(),
    event: "session.snapshot",
    data: {
      meta: metaOf(s),
      blocks: fold(s.journal),
      pending_permissions: [...s.pending.values()],
      last_seq: s.seq,
      working: s.working,
      turn_started_at: s.turnStartedAt ?? undefined,
      turn_usage: meta.turnUsage,
      session_usage: meta.sessionUsage,
      context_chars: meta.contextChars,
      diagnostics: meta.diagnostics,
      compacting: meta.compacting,
      failed: meta.failed,
      provider: s.provider,
      thinking_effort: s.thinkingEffort,
      model_locked: s.modelLocked,
    },
  };
}

// ---------- replay engine ----------

function usage(inTok, outTok) {
  return { input: inTok, output: outTok, cache_create: 0, cache_read: 0, cost_usd: 0 };
}

function echoPlan(text) {
  // Rich-rendering demo: prompt mentioning markdown/table/demo returns real
  // structured markdown plus live ```chart fences, so the web client's
  // table/list/link/chart rendering is verifiable end-to-end against a live
  // stream.
  if (/\b(markdown|table|demo)\b/i.test(text)) return demoPlan();
  const pack = /^\/pack\s+run\s+(\S+)\s*(.*)$/s.exec(text.trim());
  if (pack) return packPlan(pack[1], pack[2]);
  return [
    { event: "turn_start", delay: 5 },
    { event: "text_delta", data: "Mock agent: ", delay: 12 },
    { event: "text_delta", data: text, delay: 12 },
    { event: "text_block_complete", data: `Mock agent: ${text}`, delay: 8 },
    {
      event: "usage_update",
      data: { turn: usage(12, 24), session: usage(12, 24) },
      delay: 4,
    },
    {
      event: "turn_diagnostics",
      data: {
        provider: "mock",
        api_family: "mock",
        auth_source: "auth:none",
        model: "mock-echo",
        context_window: 128000,
        last_retry_reason: null,
        workaround_fired: false,
        turn_duration_ms: 40,
        context_mode: "Standard",
        tool_profile: "default:lean",
        compacted: false,
      },
      delay: 4,
    },
    { event: "turn_end", data: { usage: usage(12, 24), failed: false }, delay: 4 },
  ];
}

// A pack run: tool activity, then a pack-authored runtime_view card carrying
// a chart fence — the shape a real pack produces through dext.
function packPlan(name, task) {
  const md = `Ran **${name}** on: _${task || "(no task)"}_\n\n\`\`\`chart\n{"type":"bar","title":"${name} result","labels":["a","b","c"],"values":[3,7,5],"unit":""}\n\`\`\``;
  return [
    { event: "turn_start", delay: 5 },
    // dext emits pack_start once per activation, before any runtime_view.
    { event: "pack_start", data: { name, task_preview: (task || "").slice(0, 80) }, delay: 2 },
    { event: "tool_call_start", data: { call_id: "p1", name: "bash", summary: `bin/${name} --task` }, delay: 10 },
    { event: "tool_call_result", data: { call_id: "p1", name: "bash", ok: true, preview: "ok", content: "ok" }, delay: 40 },
    { event: "runtime_view", data: { pack: name, title: `${name} result`, markdown: md }, delay: 10 },
    { event: "text_block_complete", data: `Done — the ${name} pack produced one chart.`, delay: 8 },
    { event: "usage_update", data: { turn: usage(20, 40), session: usage(20, 40) }, delay: 4 },
    { event: "turn_end", data: { usage: usage(20, 40), failed: false }, delay: 4 },
  ];
}

const MD_DEMO = `## Markdown rendering demo

Structured agent output renders as **real HTML**, not wrapped monospace:

| Option | Cost | Risk | Verdict |
|:-------|-----:|:----:|:--------|
| Literal TUI clone | $0 | high | ✗ tables shred on wrap |
| Real \`<table>\` elements | $0 | low | ✓ **this** |
| Screenshot the terminal | $$$ | high | ✗ |

Why it matters:
- columns stay aligned at any viewport width
  - long cells wrap *inside* their cell
  - numeric columns right-align
- lists are real lists, links are real links: [AgentLink spec](https://example.com/agentlink)

> Terminal soul in the chrome; web power in the content.

\`\`\`rust
fn demo() -> &'static str { "code fences stay monospace" }
\`\`\`

## Charts, not ASCII

A \`\`\`chart fence carrying a JSON spec renders as a real SVG — bar · hbar · line · spark · donut:

\`\`\`chart
{"type":"bar","title":"Build minutes by task","labels":["lint","test","bundle"],"values":[42,118,63],"unit":"m"}
\`\`\`

\`\`\`chart
{"type":"donut","title":"Where the tokens went","labels":["tool output","reasoning","answer"],"values":[52,31,17]}
\`\`\`

\`\`\`chart
{"type":"spark","values":[3,7,6,11,9,14,12,18]}
\`\`\`

Done.`;

function demoPlan() {
  const chunks = [];
  const step = 160;
  for (let i = 0; i < MD_DEMO.length; i += step) {
    chunks.push({ event: "text_delta", data: MD_DEMO.slice(i, i + step), delay: 25 });
  }
  return [
    { event: "turn_start", delay: 5 },
    ...chunks,
    { event: "text_block_complete", data: MD_DEMO, delay: 8 },
    {
      event: "usage_update",
      data: { turn: usage(40, 220), session: usage(40, 220) },
      delay: 4,
    },
    { event: "turn_end", data: { usage: usage(40, 220), failed: false }, delay: 4 },
  ];
}

function beginTurn(s, plan) {
  if (s.working) return false;
  s.working = true;
  s.turnStartedAt = Date.now();
  // Apply session controls to every mock plan (fixture, demo, echo) so a
  // selected model/effort cannot be overwritten by recording-era diagnostics.
  const configured = plan.map((item) => {
    if (item.event !== "turn_diagnostics") return { ...item };
    return {
      ...item,
      data: { ...item.data, provider: s.provider, model: s.model },
    };
  });
  const end = configured.findIndex((item) => item.event === "turn_end");
  if (end >= 0) {
    configured.splice(end, 0, {
      event: "thinking_effort_changed",
      data: { effort: s.thinkingEffort },
      delay: 2,
    });
  }
  s.plan = configured;
  s.pos = 0;
  stepReplay(s);
  return true;
}

function stepReplay(s) {
  if (!s.working || !s.plan) return;
  const tick = () => {
    if (!s.working || !s.plan) return;
    if (s.pos >= s.plan.length) {
      s.working = false;
      s.turnStartedAt = null;
      s.plan = null;
      return;
    }
    const item = s.plan[s.pos++];
    if (item.pause === "approval") {
      const startEnv = [...s.journal].reverse().find((e) => e.event === "tool_call_start");
      const ref = startEnv
        ? startEnv.data
        : { call_id: `call_${s.id}_${s.approvalCounter + 1}`, name: "bash", summary: "bash: (mock)" };
      openApproval(s, ref);
      return;
    }
    if (item.event === "turn_end") {
      // Mark the engine ready before publishing the event that re-enables the
      // composer; an immediate next prompt must not receive a false busy.
      s.working = false;
      s.turnStartedAt = null;
      s.plan = null;
      s.turns += 1;
      s.modelLocked = true;
      publish(journalData(s, "session.configured", {
        provider: s.provider,
        model: s.model,
        thinking_effort: s.thinkingEffort,
        model_locked: true,
      }));
      publish(journalData(s, item.event, item.data));
      return;
    }
    publish(journalData(s, item.event, item.data));
    s.timer = setTimeout(tick, item.delay ?? 5);
  };
  s.timer = setTimeout(tick, 5);
}

function openApproval(s, ref) {
  const request_id = `req_${s.id}_${++s.approvalCounter}`;
  const p = {
    request_id,
    call_id: ref.call_id,
    tool: ref.name,
    summary: ref.summary,
    input: { note: "synthetic approval request (mock host)" },
    risk: "write",
  };
  s.pending.set(request_id, p);
  publish(journalData(s, "permission.request", p));
  s.timer = setTimeout(() => {
    if (!s.pending.has(request_id)) return;
    s.pending.delete(request_id);
    publish(journalData(s, "permission.timeout", { request_id }));
    applyDeny(s);
    stepReplay(s);
  }, s.approvalTimeoutMs);
}

function applyDeny(s) {
  if (!s.plan) return;
  for (let i = s.pos; i < s.plan.length; i++) {
    const it = s.plan[i];
    if (it.event === "tool_call_result") {
      it.data = { ...it.data, ok: false, content: "denied by operator" };
      break;
    }
  }
}

/** Auto-deny every dangling approval (interrupt / session close). */
function flushPending(s) {
  for (const rid of [...s.pending.keys()]) {
    s.pending.delete(rid);
    publish(journalData(s, "permission.timeout", { request_id: rid }));
  }
}

function resolveApproval(client, s, requestId, choice) {
  const p = s.pending.get(requestId);
  if (!p) {
    client.send(
      JSON.stringify({
        v: 1,
        session: s.id,
        ts: Date.now(),
        event: "permission.already_resolved",
        data: { request_id: requestId },
      }),
    );
    return;
  }
  clearTimeout(s.timer);
  s.pending.delete(requestId);
  if (choice === "deny") applyDeny(s);
  publish(journalData(s, "permission.resolved", { request_id: requestId, choice, by: client.id }));
  stepReplay(s);
}

// ---------- command dispatch ----------

function sendControl(client, event, data) {
  const env = { v: 1, ts: Date.now(), event };
  if (data !== undefined) env.data = data;
  client.send(JSON.stringify(env));
}

function sendError(client, code, message) {
  sendControl(client, "error", { code, message });
}

function manageSession(s, remove, by) {
  clearTimeout(s.timer);
  s.pending.clear();
  s.plan = null;
  s.working = false;
  s.turnStartedAt = null;
  s.pos = 0;
  s.journal = [];
  s.seq = 0;
  s.turns = 0;
  s.modelLocked = false;
  s.generation++;
  s.status = remove ? "exited" : "live";
  if (remove) sessions.delete(s.id);
  const event = remove ? "session.removed" : "session.cleared";
  for (const c of clients) {
    c.subs.delete(s.id);
    if (c.phase === "live") sendControl(c, event, { id: s.id, generation: s.generation, by });
  }
  scheduleList();
}

function handleCommand(client, frame) {
  if (frame.v !== 1) {
    sendError(client, "bad_version", "unsupported protocol version");
    return;
  }
  if (client.phase === "authing") {
    if (frame.cmd !== "hello") {
      sendError(client, "not_authenticated", "hello required");
      return;
    }
    if (frame.token !== TOKEN) {
      sendControl(client, "hello_fail", { reason: "invalid token" });
      client.close(1008);
      return;
    }
    client.phase = "live";
    sendControl(client, "hello_ok", {
      server: "agentlink-mock",
      version: "0.1.0",
      protocol: 1,
      instance: INSTANCE,
      capabilities: CAPABILITIES,
      sessions: [...sessions.values()].map(metaOf),
      model_catalog: MOCK_MODEL_CATALOG,
      effort_options: EFFORT_OPTIONS,
      commands: COMMANDS,
      packs: PACKS,
      home: MOCK_HOME,
    });
    return;
  }
  if (client.phase !== "live") return;

  switch (frame.cmd) {
    case "ping":
      sendControl(client, "pong", {});
      return;

    case "hello":
      sendError(client, "already_authenticated", "hello already completed");
      return;

    case "session.open": {
      let s;
      if (frame.id) {
        s = sessions.get(frame.id);
        if (!s) {
          sendError(client, "no_session", `unknown session ${frame.id}`);
          return;
        }
        if (s.status === "cold") {
          s.status = "starting";
          publish(journalData(s, "session.state", { status: "starting" }));
          setTimeout(() => {
            // The session may have been closed (back to cold) while starting.
            if (s.status !== "starting" || !sessions.has(s.id)) return;
            s.status = "live";
            publish(journalData(s, "session.state", { status: "live" }));
          }, 250);
        }
      } else {
        s = makeSession({ title: "New session", fixture: null, approvalFlow: false, live: true });
        publish(journalData(s, "session.state", { status: "live" }));
      }
      return;
    }

    case "session.subscribe": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      client.subs.add(s.id);
      const since = frame.since_seq;
      if (typeof since === "number" && since >= 0 && since <= s.seq) {
        for (const env of s.journal) if (env.seq > since) client.send(JSON.stringify(env));
      } else {
        client.send(JSON.stringify(snapshotEnvelope(s)));
      }
      return;
    }

    case "session.unsubscribe": {
      client.subs.delete(frame.id);
      return;
    }

    case "session.configure": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      if (s.status !== "live") {
        sendError(client, "not_live", "session is not live");
        return;
      }
      if (s.working) {
        sendError(client, "busy", "settings apply between turns");
        return;
      }
      const wantsModel = frame.provider !== undefined || frame.model !== undefined;
      if (wantsModel) {
        if (s.modelLocked || s.turns > 0) {
          sendError(client, "model_locked", "this session has history; start a new session to change model");
          return;
        }
        const group = MOCK_MODEL_CATALOG.find((g) => g.provider === frame.provider);
        if (!group || typeof frame.model !== "string" || !group.models.includes(frame.model)) {
          sendError(client, "bad_request", `unknown model selection ${String(frame.provider)}/${String(frame.model)}`);
          return;
        }
        s.provider = frame.provider;
        s.model = frame.model;
      }
      if (frame.thinking_effort !== undefined) {
        if (!EFFORTS.has(frame.thinking_effort)) {
          sendError(client, "bad_request", `invalid thinking effort '${String(frame.thinking_effort)}'`);
          return;
        }
        s.thinkingEffort = frame.thinking_effort;
      }
      publish(journalData(s, "session.configured", {
        provider: s.provider,
        model: s.model,
        thinking_effort: s.thinkingEffort,
        model_locked: s.modelLocked,
      }));
      return;
    }

    case "session.rename": {
      const s = sessions.get(frame.id);
      if (!s || typeof frame.title !== "string" || !frame.title.trim()) {
        sendError(client, "bad_request", "session.rename needs id and title");
        return;
      }
      s.title = frame.title.trim().slice(0, 80);
      scheduleList();
      return;
    }

    case "session.close": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      clearTimeout(s.timer);
      if (s.working) publish(journalData(s, "interrupted"));
      s.working = false;
      s.turnStartedAt = null;
      s.plan = null;
      s.status = "cold";
      flushPending(s);
      // Subscribers track status from events, not the list — tell them.
      publish(journalData(s, "session.state", { status: "cold" }));
      return;
    }

    case "session.delete":
    case "session.clear": {
      const s = sessions.get(frame.id);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.id}`);
        return;
      }
      manageSession(s, frame.cmd === "session.delete", client.id);
      return;
    }

    case "session.delete_all": {
      if (!["all", "cold", "exited"].includes(frame.scope)) {
        sendError(client, "bad_request", "session.delete_all requires scope: all | cold | exited");
        return;
      }
      const targets = [...sessions.values()].filter((s) => frame.scope === "all" ||
        s.status === frame.scope || (frame.scope === "cold" && s.status === "exited"));
      for (const s of targets) manageSession(s, true, client.id);
      sendControl(client, "sessions.deleted", { ids: targets.map((s) => s.id), scope: frame.scope });
      return;
    }

    case "prompt.submit": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      if (typeof frame.text !== "string" || !frame.text.trim()) {
        sendError(client, "bad_request", "text required");
        return;
      }
      if (s.status !== "live") {
        sendError(client, "not_live", "session is not live; open it first");
        return;
      }
      publish(journalData(s, "user_message", { text: frame.text }));
      if (!s.title || s.title.startsWith("New session") || s.title.startsWith("Fixture:")) {
        s.title = frame.text.slice(0, 60);
      }
      if (s.fixture) {
        const script = loadFixture(s.fixture);
        beginTurn(s, s.approvalFlow ? withApprovalPause(script) : script);
      } else {
        beginTurn(s, echoPlan(frame.text.trim().slice(0, 400)));
      }
      return;
    }

    case "steering.inject": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      if (!s.working) {
        sendError(client, "not_running", "no turn in flight to steer");
        return;
      }
      publish(journalData(s, "steering_received", { messages: [String(frame.text ?? "")], preview: String(frame.text ?? "").slice(0, 80) }));
      return;
    }

    case "interrupt": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      clearTimeout(s.timer);
      if (s.working) {
        s.working = false;
        s.plan = null;
        publish(journalData(s, "interrupted"));
      }
      // A dead turn must not leave approval cards hanging.
      flushPending(s);
      return;
    }

    case "permission.respond": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      if (!["once", "always", "deny"].includes(frame.choice)) {
        sendError(client, "bad_request", "choice must be once|always|deny");
        return;
      }
      resolveApproval(client, s, frame.request_id, frame.choice);
      return;
    }

    case "slash": {
      const s = sessions.get(frame.session);
      if (!s) {
        sendError(client, "no_session", `unknown session ${frame.session}`);
        return;
      }
      const raw = String(frame.raw ?? "").trim();
      // `/pack run <name> <task>` and the `/pack <name> <task>` shorthand, as agentlinkd.
      const run = /^\/packs?\s+(?:(?:run|use|start)\s+)?([A-Za-z0-9][A-Za-z0-9_-]*)\s*(.*)$/s.exec(raw);
      if (run && !/^(list|ls|inspect|info|show|create|new)$/.test(run[1])) {
        const pack = PACKS.find((p) => p.name === run[1]);
        if (!pack) {
          sendError(client, "no_pack", `unknown pack '${run[1]}'; see /pack list`);
          return;
        }
        const task = run[2].trim();
        if (!task) {
          sendError(client, "bad_request", `/pack run ${pack.name} needs a task`);
          return;
        }
        const need = pack.ui.requires.find((r) => r.startsWith("approval:"));
        const profile = s.approvalProfile ?? (s.approvalFlow ? "ask" : "always");
        if (need && profile !== need.slice(9) && profile !== "always") {
          sendControl(client, "error", {
            code: "pack_requires_profile",
            message: `${pack.name} needs approval profile ${need.slice(9)}; this session is ${profile}`,
            data: { pack: pack.name, required: need.slice(9), current: profile, session: s.id, retry: `/pack run ${pack.name} ${task}` },
          });
          return;
        }
        if (s.working) {
          sendError(client, "busy", "turn in flight");
          return;
        }
        const text = `/pack run ${pack.name} ${task}`;
        publish(journalData(s, "user_message", { text }));
        if (s.title === "New session") s.title = text.slice(0, 60);
        beginTurn(s, echoPlan(text));
        return;
      }
      if (/^\/packs?(\s+list)?$/.test(raw)) {
        publish(journalData(s, "structured_slash", [`packs  ${PACKS.length} installed`, ...PACKS.map((p) => `  ${p.name.padEnd(14)} ${p.shelf}  ${p.description.slice(0, 60)}`)].join("\n")));
        return;
      }
      if (/^\/approval\s+\S+$/.test(raw)) {
        const profile = raw.split(/\s+/)[1];
        if (!["ask", "auto-read", "auto-write", "never", "always"].includes(profile)) {
          sendError(client, "bad_request", `unknown approval profile '${profile}'`);
          return;
        }
        s.approvalProfile = profile;
        publish(journalData(s, "approval_profile_changed", { profile }));
        publish(journalData(s, "slash", `approval profile → ${profile} (next turn)`));
        scheduleList();
        return;
      }
      publish(journalData(s, "slash", `[mock] ${raw.slice(0, 200)}`));
      return;
    }

    case "x-agentlinkd.dirs.list": {
      const r = mockDirsList(frame.path);
      if (r.error) sendError(client, r.error, `cannot list folder: ${r.error}`, frame.cmd);
      else sendControl(client, "x-agentlinkd.dirs.list", r);
      return;
    }
    case "x-agentlinkd.dirs.create": {
      const parent = mockDirsList(frame.path);
      const name = typeof frame.name === "string" ? frame.name.trim() : "";
      if (parent.error || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/.test(name)) { sendError(client, parent.error ?? "bad_request", "cannot create folder", frame.cmd); return; }
      if (MOCK_DIRS.has(`${parent.path}/${name}`)) { sendError(client, "exists", "cannot create folder: exists", frame.cmd); return; }
      MOCK_DIRS.set(`${parent.path}/${name}`, { dirs: [], files: 0 });
      MOCK_DIRS.get(parent.path).dirs.push(name);
      MOCK_DIRS.get(parent.path).dirs.sort();
      sendControl(client, "x-agentlinkd.dirs.list", { ...mockDirsList(parent.path), created: `${parent.path}/${name}` });
      return;
    }

    case "x-agentlinkd.flows.list":
      sendControl(client, "x-agentlinkd.flows.list", { cwd: MOCK_HOME, flows: mockFlowList() });
      return;
    case "x-agentlinkd.flows.get": {
      const f = MOCK_FLOWS.get(frame.name);
      if (!f) sendError(client, "no_flow", `flow '${frame.name}': no_flow`, frame.cmd);
      else sendControl(client, "x-agentlinkd.flows.get", { cwd: MOCK_HOME, flow: f });
      return;
    }
    case "x-agentlinkd.flows.put": {
      const f = frame.flow;
      if (!f || typeof f.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name) || !Array.isArray(f.nodes) || f.nodes.length === 0) {
        sendError(client, "bad_request", "flow not saved: flow needs a valid name and at least one node", frame.cmd);
        return;
      }
      MOCK_FLOWS.set(f.name, { version: 1, name: f.name, title: f.title, desc: f.desc, nodes: f.nodes, edges: Array.isArray(f.edges) ? f.edges : [] });
      sendControl(client, "x-agentlinkd.flows.put", { cwd: MOCK_HOME, flow: MOCK_FLOWS.get(f.name), bytes: JSON.stringify(f).length });
      broadcastControl("x-agentlinkd.flows.changed", { cwd: MOCK_HOME, flows: mockFlowList() });
      return;
    }
    case "x-agentlinkd.flows.delete":
      if (!MOCK_FLOWS.delete(frame.name)) sendError(client, "no_flow", `flow '${frame.name}': no_flow`, frame.cmd);
      else broadcastControl("x-agentlinkd.flows.changed", { cwd: MOCK_HOME, flows: mockFlowList() });
      return;
    case "x-agentlinkd.flows.compile": {
      const f = MOCK_FLOWS.get(frame.name);
      if (!f) { sendError(client, "no_flow", `flow '${frame.name}': no_flow`, frame.cmd); return; }
      sendControl(client, "x-agentlinkd.flows.compile", { cwd: MOCK_HOME, name: f.name, spec: { task: f.title ?? f.name, steps: f.nodes.map((n) => ({ agent: "worker", label: n.label ?? n.id, task: `[mock] ${n.type} ${n.id}` })) } });
      return;
    }
    case "x-agentlinkd.flows.run": {
      const f = MOCK_FLOWS.get(frame.name);
      if (!f) { sendError(client, "no_flow", `flow '${frame.name}': no_flow`, frame.cmd); return; }
      sendControl(client, "x-agentlinkd.flows.run", { cwd: MOCK_HOME, name: f.name, spec_path: `${MOCK_HOME}/.crew/specs/flow-${f.name}.json`, started: true });
      return;
    }

    default:
      sendError(client, "unknown_command", `unsupported cmd ${String(frame.cmd)}`);
  }
}

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function requireAuth(req) {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${TOKEN}`;
}

function digest() {
  return {
    server: "agentlink-mock",
    now: Date.now(),
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      working: s.working,
      model: s.model,
      pending: [...s.pending.values()].map((p) => ({
        request_id: p.request_id,
        tool: p.tool,
        summary: p.summary,
      })),
    })),
    actions: [
      "session.open",
      "session.subscribe",
      "prompt.submit",
      "steering.inject",
      "interrupt",
      "permission.respond",
      "session.configure",
      "slash",
      "session.rename",
      "session.close",
    ],
  };
}

const server = http.createServer((req, res) => {
  const pathName = new URL(req.url, "http://localhost").pathname;
  if (pathName === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: "agentlink-mock", protocol: 1 }));
    return;
  }
  // Data endpoints require the pairing token. The static app shell is public —
  // assets carry no data and the browser cannot attach headers to them anyway.
  if (pathName === "/sessions" || pathName === "/__agent") {
    if (!requireAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (pathName === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: [...sessions.values()].map(metaOf) }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(digest()));
    return;
  }
  // static PWA
  const rel = pathName === "/" ? "index.html" : pathName.slice(1);
  const file = path.resolve(STATIC_DIR, rel);
  // startsWith needs the separator: "/x/dist-evil" starts with "/x/dist".
  if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found (build apps/web to serve the PWA)");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

// ---------- WS ----------

server.on("upgrade", (req, socket, head) => {
  const pathName = new URL(req.url, "http://localhost").pathname;
  const key = req.headers["sec-websocket-key"];
  const upgradeOk =
    /^websocket$/i.test(req.headers.upgrade ?? "") && /upgrade/i.test(req.headers.connection ?? "");
  if (pathName !== "/ws" || !upgradeOk || typeof key !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  // Node has already consumed the request headers; accept via req.headers and
  // feed the leftover `head` bytes (possibly the client's first frame) to the parser.
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const client = {
    id: `c${++clientCounter}`,
    phase: "authing",
    subs: new Set(),
    send: (text) => socket.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8"))),
    close: (code) => {
      try {
        // Close status code is a big-endian u16 (RFC 6455 §5.5.1).
        socket.end(encodeFrame(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])));
      } catch {
        /* already gone */
      }
    },
  };
  clients.add(client);
  const parser = new FrameParser({
    onMessage: (payload) => {
      let frame;
      try {
        frame = JSON.parse(payload.toString("utf8"));
      } catch {
        if (client.phase === "live") sendError(client, "bad_json", "malformed frame");
        return;
      }
      handleCommand(client, frame);
    },
    onClose: () => {
      clients.delete(client);
      socket.destroy();
    },
    onPing: (payload) => socket.write(encodeFrame(OP_PONG, payload)),
  });
  if (head && head.length > 0) parser.push(head);
  socket.on("data", (chunk) => parser.push(chunk));
  socket.on("close", () => clients.delete(client));
  socket.on("error", () => clients.delete(client));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agentlink-mock listening on http://127.0.0.1:${server.address().port}`);
  console.log(`  token: ${TOKEN}`);
  console.log(`  sessions: ${seededText.id} (text fixture), ${seededTool.id} (tool fixture + synthetic approval)`);
});
