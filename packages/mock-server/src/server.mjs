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
import { suggestPack } from "../../agentlinkd/src/packs.mjs";

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
  // GET /sessions/:id/file + POST /sessions/:id/{upload,fetch} over an
  // in-memory store — the attach flow is demoable offline in dev.
  "files_read",
  "files_write",
  "packs",
  // x-agentlinkd.dirs.{list,create} over an in-memory tree (no filesystem).
  "dirs",
  // x-agentlinkd.flows.* over an in-memory store; run = a synthetic reply.
  "flows",
  // x-agentlinkd.connectors.* over an in-memory registry (sync is a timer).
  "connectors",
  // x-agentlinkd.auth.* over an in-memory provider store.
  "provider_auth",
  // x-agentlinkd.packs.credentials.set over an in-memory value store —
  // values never echo back, only the names-only status event.
  "pack_credentials",
];

// In-memory connectors + provider auth so the picker's Connected section and
// the Providers dialog are exercisable against the mock.
const MOCK_CONNECTORS = new Map();
const MOCK_TICKETS = new Map();
const MOCK_AUTH = new Map([["mock-a", "auth"], ["mock-b", "none"]]);
function mockConnectorsList(extra = {}) {
  return {
    connectors: [...MOCK_CONNECTORS.values()],
    tools: { git: true, rclone: true, gh: false },
    root: `${MOCK_HOME}/Connected`,
    ...extra,
  };
}
function mockAuthStatus(extra = {}) {
  return {
    active: "mock-a",
    providers: [...MOCK_AUTH].map(([id, auth]) => ({ id, label: id === "mock-a" ? "Mock A" : "Mock B", model: id === "mock-a" ? "alpha" : "beta", auth, active: id === "mock-a" })),
    model_catalog: MOCK_MODEL_CATALOG,
    ...extra,
  };
}
function broadcastControl(event, data) {
  for (const c of clients) if (c.phase === "live") sendControl(c, event, data);
}

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
  return [...MOCK_FLOWS.values()].map((f) => ({ name: f.name, title: f.title ?? f.name, desc: f.desc ?? "", nodes: f.nodes.length, edges: f.edges.length, triggers: (f.triggers ?? []).length, mtime: Date.now() }));
}

function mockTriggers() {
  const out = [];
  for (const f of MOCK_FLOWS.values()) {
    for (const t of f.triggers ?? []) {
      out.push({ cwd: MOCK_HOME, name: f.name, kind: t.kind, enabled: t.enabled !== false, detail: t.every ? `every ${t.every} min` : t.daily_at ? `daily at ${t.daily_at}` : t.path ? `watch ${t.path}` : t.node ? `mesh ${t.node}` : "webhook", last: null, ...(t.kind === "webhook" ? { hook: `/hooks/mock${f.name.padEnd(28, "0").slice(0, 28)}` } : {}) });
    }
  }
  return out;
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
    ui: { starter_prompt: "Summarise this workspace as an HTML report", artifact: "html", time_to_first_artifact: 45, requires: ["approval:auto-write"], gallery: true, tags: ["research"], icon: "report" }, credential_env: ["REPORT_API_KEY"], credentials: { set: [], missing: ["REPORT_API_KEY"] }, unmet: ["approval:auto-write"] },
  { name: "agent_browser", shelf: "engineering", description: "Headless Chromium automation via the agent-browser CLI.", source: "user:~/.dext/shelves/engineering", path: "/mock/engineering/packs/agent_browser",
    ui: { starter_prompt: "Fetch the title of example.com", artifact: "markdown", time_to_first_artifact: 20, requires: ["chromium"], gallery: true, tags: ["browser"], icon: "browser" }, unmet: ["chromium"] },
  { name: "mesh", shelf: "orchestration", description: "Peer-to-peer mailbox between independent Dext sessions.", source: "user:~/.dext/shelves/orchestration", path: "/mock/orchestration/packs/mesh",
    ui: { starter_prompt: "/pack run mesh ", artifact: "markdown", time_to_first_artifact: 0, requires: [], gallery: false, tags: [], }, unmet: [] },
];

// In-memory pack credential values (real host: 0600 files under DEXT_HOME).
// Only names ever leave this process — same rule as the real store.
const PACK_CRED_STORE = new Map();

// Host-driven composer completion (mirrors the slash.* caps above).
const COMMANDS = [
  { cmd: "/help", desc: "List host commands" },
  { cmd: "/login", desc: "Sign-in help; --show reveals the access code" },
  { cmd: "/approval", desc: "Set dext approval profile" },
  { cmd: "/compact", desc: "Compact session context" },
  { cmd: "/model", desc: "Show or switch model" },
  { cmd: "/todos", desc: "Show the todo list" },
  ...PACKS.map((p) => ({ cmd: `/pack run ${p.name}`, desc: p.description })),
  { cmd: "/pack list", desc: "List installed packs" },
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
      context_tokens: meta.contextTokens,
      context_source: meta.contextSource,
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
  if (/\btool folding demo\b/i.test(text)) return toolFoldingPlan();
  if (/\bthinking preview demo\b/i.test(text)) return thinkingPreviewPlan();
  if (/\bAttached images? candidates? for native read_image\b/i.test(text) && /\bread_image\(path\)/i.test(text)) return imageVisionPlan(text);
  if (/\bartifact file demo\b/i.test(text)) return fileArtifactPlan();
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

function toolFoldingPlan() {
  const tool = (call_id, name, summary, content, ok = true) => [
    { event: "tool_call_start", data: { call_id, name, summary }, delay: 8 },
    { event: "tool_call_result", data: { call_id, name, summary, ok, content }, delay: 18 },
  ];
  return [
    { event: "turn_start", delay: 5 },
    { event: "info", data: "[objective: Make tool-heavy work easier to scan | checkpoints: inspect the renderer; preserve rich Bash; verify drill-down]", delay: 2 },
    { event: "info", data: "[phase:probe] Inspecting transcript structure", delay: 2 },
    { event: "text_block_complete", data: "Inspecting the transcript renderer and its current batch boundaries.", delay: 3 },
    { event: "tool_batch_start", data: { labels: ["rg: /tool/ in apps/web/src", "read_file: apps/web/src/components/Scrollback.svelte", "git_diff: apps/web/src"] }, delay: 2 },
    ...tool("fold-rg", "rg", "rg: /tool/ in apps/web/src", "Scrollback.svelte: tool renderer\nBlock.svelte: tool details"),
    ...tool("fold-read", "read_file", "read_file: apps/web/src/components/Scrollback.svelte", "1 <script lang=\"ts\">\n2 import Block from './Block.svelte';\n3 // transcript rendering"),
    ...tool("fold-diff", "git_diff", "git_diff: apps/web/src", "diff --git a/Scrollback.svelte b/Scrollback.svelte\n@@ -1,2 +1,3 @@\n import Block from './Block.svelte';\n+import ActivityGroup from './ActivityGroup.svelte';"),
    { event: "tool_batch_end", data: { failed: 0 }, delay: 2 },
    { event: "tool_call_start", data: { call_id: "fold-bash", name: "bash", summary: "npm test" }, delay: 8 },
    { event: "tool_output_delta", data: { call_id: "fold-bash", text: "249 tests passed\n" }, delay: 12 },
    { event: "tool_call_result", data: { call_id: "fold-bash", name: "bash", summary: "npm test", ok: true, content: "exit: 0\n--- stdout ---\n249 tests passed\n--- stderr ---" }, delay: 18 },
    { event: "info", data: "[phase:implement] Folding routine reads and edits", delay: 2 },
    { event: "text_block_complete", data: "Applying the compact activity presentation.", delay: 3 },
    { event: "tool_batch_start", data: { labels: ["edit_file: Scrollback.svelte", "multi_edit: ActivityGroup.svelte (3 edits)"] }, delay: 2 },
    ...tool("fold-edit", "edit_file", "edit_file: apps/web/src/components/Scrollback.svelte", "@@ -24,2 +24,3 @@\n const visible = view.blocks;\n+const items = transcriptItems(visible);"),
    ...tool("fold-multi", "multi_edit", "multi_edit: apps/web/src/components/ActivityGroup.svelte (3 edits)", "@@ -40,2 +40,4 @@\n+<details class=\"activity\">\n+  <summary>Changed files</summary>\n+</details>"),
    { event: "tool_batch_end", data: { failed: 0 }, delay: 2 },
    { event: "info", data: "[phase:verify] Checking failure visibility", delay: 2 },
    { event: "text_block_complete", data: "Checking that a failed structural call opens its activity group.", delay: 3 },
    ...tool("fold-fail", "read_file", "read_file: missing.fixture", "file not found", false),
    { event: "text_block_complete", data: "Tool folding demo complete — Bash stayed rich, routine work folded, and every detail remains reachable.", delay: 5 },
    { event: "usage_update", data: { turn: usage(80, 100), session: usage(80, 100) }, delay: 4 },
    { event: "turn_end", data: { usage: usage(80, 100), failed: false }, delay: 4 },
  ];
}

function thinkingPreviewPlan() {
  const thought = Array.from({ length: 120 }, (_, i) => `reasoning-${i + 1}`).join(" ");
  return [
    { event: "turn_start", delay: 5 },
    { event: "thinking_delta", data: thought, delay: 700 },
    { event: "thinking_block_complete", data: thought, delay: 5 },
    { event: "thinking_preview_committed", delay: 5 },
    { event: "text_block_complete", data: "Thinking preview complete.", delay: 5 },
    { event: "usage_update", data: { turn: usage(20, 10), session: usage(20, 10) }, delay: 4 },
    { event: "turn_end", data: { usage: usage(20, 10), failed: false }, delay: 4 },
  ];
}

function imageVisionPlan(text) {
  const imagePath = text
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .find((record) => typeof record?.path === "string" && /\.(?:png|jpe?g|webp)$/i.test(record.path))
    ?.path ?? "uploads/image.png";
  const ref = { call_id: "vision_1", name: "read_image", summary: `read_image: ${imagePath} (pixels will be sent to the model provider)`, input: { path: imagePath } };
  return [
    { event: "turn_start", delay: 5 },
    { event: "tool_call_start", data: ref, delay: 5 },
    { pause: "approval" },
    { event: "tool_call_result", data: { ...ref, ok: true, preview: ref.summary, content: `approved image ${imagePath} (1x1, sanitized as image/jpeg); pixels are available to the model only in this turn` }, delay: 5 },
    { event: "text_block_complete", data: "I inspected the attached image with native vision.", delay: 5 },
    { event: "usage_update", data: { turn: usage(18, 12), session: usage(18, 12) }, delay: 4 },
    { event: "turn_end", data: { usage: usage(18, 12), failed: false }, delay: 4 },
  ];
}

function fileArtifactPlan() {
  const markdown = "![Workspace report](uploads/report.html)\n\n[Download the source brief](uploads/brief.docx)";
  return [
    { event: "turn_start", delay: 5 },
    { event: "text_block_complete", data: markdown, delay: 8 },
    { event: "usage_update", data: { turn: usage(8, 12), session: usage(8, 12) }, delay: 4 },
    { event: "turn_end", data: { usage: usage(8, 12), failed: false }, delay: 4 },
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

// Optional local fixture for repeatable visual/report regression checks.
const MD_DEMO = process.env.MOCK_MARKDOWN_FILE ? fs.readFileSync(process.env.MOCK_MARKDOWN_FILE, "utf8") : `## Markdown rendering demo

Structured agent output renders as **real HTML**, not wrapped monospace:

\`\`\`html
<!doctype html><html><body><h2>Interactive report demo</h2><label>Load <input type="range" min="1" max="10" value="4"></label><p>This report runs in the sandboxed artifact sheet.</p></body></html>
\`\`\`

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
  const image = ref.name === "read_image";
  const p = {
    request_id,
    call_id: ref.call_id,
    tool: ref.name,
    summary: ref.summary,
    input: image ? ref.input : { note: "synthetic approval request (mock host)" },
    risk: image ? "sensitive read" : "write",
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

// Delivery receipts (parity with agentlinkd): nonce-tagged prompt/steer/slash
// frames are acked so the client does not report them unsent after its TTL;
// rejections still arrive as ordinary error frames.
function sendAck(client, frame) {
  if (typeof frame.nonce !== "string" || !frame.nonce) return;
  sendControl(client, "cmd_ack", { nonce: frame.nonce, ok: true, cmd: String(frame.cmd ?? "") });
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

    case "x-agentlinkd.packs.credentials.set": {
      const pack = PACKS.find((p) => p.name === frame.name);
      if (!pack?.credential_env?.length) {
        sendError(client, "no_pack", `pack '${frame.name}' declares no credentials`, frame.cmd);
        return;
      }
      if (frame.values !== undefined && (frame.values === null || typeof frame.values !== "object" || Array.isArray(frame.values))) {
        sendError(client, "bad_request", "values must be an object of NAME → value", frame.cmd);
        return;
      }
      const allowed = new Set(pack.credential_env);
      const store = PACK_CRED_STORE.get(pack.name) ?? {};
      for (const [k, v] of Object.entries(frame.values ?? {})) {
        if (!allowed.has(k)) { sendError(client, "bad_request", `${k} is not a credential this pack declares`, frame.cmd); return; }
        if (typeof v !== "string" || !v.trim()) { sendError(client, "bad_request", `${k}: value must be a non-empty string`, frame.cmd); return; }
        store[k] = v.trim();
      }
      for (const k of frame.clear ?? []) {
        if (!allowed.has(k)) { sendError(client, "bad_request", `${k} is not a credential this pack declares`, frame.cmd); return; }
        delete store[k];
      }
      PACK_CRED_STORE.set(pack.name, store);
      const set = pack.credential_env.filter((n) => store[n]);
      pack.credentials = { set, missing: pack.credential_env.filter((n) => !store[n]) };
      sendControl(client, "x-agentlinkd.packs.credentials", { name: pack.name, ...pack.credentials });
      // Parity with the real host: the chip reads app.packs, which only moves
      // on packs.changed — without this the mock's counts stale until reconnect.
      broadcastControl("packs.changed", { packs: PACKS, commands: COMMANDS });
      return;
    }

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
        sendError(client, "busy", frame.cwd !== undefined ? "the folder changes between turns — wait for this one to finish" : "settings apply between turns");
        return;
      }
      let nextCwd = null;
      if (frame.cwd !== undefined) {
        const r = mockDirsList(frame.cwd);
        if (r.error) {
          sendError(client, "bad_request", `cwd refused — ${r.error === "bad_path" ? "folder is outside the host's root" : "folder does not exist"}: ${String(frame.cwd)}`);
          return;
        }
        nextCwd = r.path;
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
      if (nextCwd && nextCwd !== s.cwd) {
        const from = s.cwd;
        s.cwd = nextCwd;
        publish(journalData(s, "info", `Folder: ${from} → ${nextCwd}`));
      }
      publish(journalData(s, "session.configured", {
        provider: s.provider,
        model: s.model,
        thinking_effort: s.thinkingEffort,
        model_locked: s.modelLocked,
        cwd: s.cwd,
      }));
      if (nextCwd) scheduleList();
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
      sendAck(client, frame);
      publish(journalData(s, "user_message", { text: frame.text }));
      if (/\bartifact file demo\b/i.test(frame.text)) {
        MOCK_UPLOADS.set(`${s.id}/uploads/report.html`, {
          mime: "text/html; charset=utf-8",
          buf: Buffer.from('<!doctype html><html><head><title>File artifact demo</title></head><body><h1>Workspace report</h1><img src="pixel.png" alt="pixel"></body></html>'),
        });
        MOCK_UPLOADS.set(`${s.id}/uploads/pixel.png`, {
          mime: "image/png",
          buf: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
        });
        MOCK_UPLOADS.set(`${s.id}/uploads/brief.docx`, {
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buf: Buffer.from("mock docx"),
        });
      }
      if (!s.title || s.title.startsWith("New session") || s.title.startsWith("Fixture:")) {
        s.title = frame.text.slice(0, 60);
      }
      if (/\bthinking preview demo\b/i.test(frame.text)) {
        beginTurn(s, echoPlan(frame.text.trim().slice(0, 4000)));
      } else if (/\bAttached images? candidates? for native read_image\b/i.test(frame.text) && /\bread_image\(path\)/i.test(frame.text)) {
        beginTurn(s, echoPlan(frame.text.trim().slice(0, 4000)));
      } else if (s.fixture) {
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
      sendAck(client, frame);
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
      sendAck(client, frame);
      const raw = String(frame.raw ?? "").trim();
      if (raw === "/compact") {
        if (s.working || s.compacting) {
          sendError(client, "busy", "context compaction starts between turns");
          return;
        }
        s.compacting = true;
        s.turnStartedAt = Date.now();
        publish(journalData(s, "compact_start"));
        s.timer = setTimeout(() => {
          if (!s.compacting) return;
          publish(journalData(s, "history_context_updated", { chars: 4800, tokens: 1200 }));
          publish(journalData(s, "compact_end", {
            before: 48,
            after: 11,
            summary: "Task\nKeep the current objective, decisions, changed files, verification, and open work.",
          }));
          s.compacting = false;
          s.turnStartedAt = null;
        }, 700);
        return;
      }
      if (/^\/compact\s+(?:status|auto|(?:100|[1-9]\d?)%?)$/i.test(raw)) {
        publish(journalData(s, "slash", `compact setting: ${raw.slice(9)}`));
        return;
      }
      if (raw.startsWith("/compact")) {
        sendError(client, "bad_request", "usage: /compact [status|auto|<percent>|<percent>%]");
        return;
      }
      // `/pack run <name> <task>` and the `/pack <name> <task>` shorthand, as agentlinkd.
      const run = /^\/packs?\s+(?:(?:run|use|start)\s+)?([A-Za-z0-9][A-Za-z0-9_-]*)\s*(.*)$/s.exec(raw);
      if (run && !/^(list|ls|inspect|info|show|create|new)$/.test(run[1])) {
        let pack = PACKS.find((p) => p.name === run[1]);
        if (!pack) {
          // Parity with agentlinkd: a confident near-miss runs as the real name,
          // an ambiguous one fails with candidates + a one-click retry.
          const fix = suggestPack(run[1], PACKS);
          if (fix?.confident) {
            pack = PACKS.find((p) => p.name === fix.name);
            publish(journalData(s, "info", `pack '${run[1]}' → ${fix.name}`));
          } else {
            const hint = fix ? ` — did you mean ${fix.candidates.map((c) => `'${c}'`).join(", ")}?` : "";
            sendControl(client, "error", {
              code: "no_pack",
              message: `unknown pack '${run[1]}'${hint}; see /pack list`,
              ...(fix ? { data: { pack: run[1], candidates: fix.candidates, session: s.id, retry: `/pack run ${fix.candidates[0]} ${run[2].trim()}`.trim() } } : {}),
            });
            return;
          }
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
      if (raw === "/login" || raw === "/login --show") {
        publish(journalData(s, "structured_slash", raw.endsWith("--show")
          ? `access code: ${TOKEN}`
          : "sign in on another device: open the host address there and enter the access code (/login --show prints it here)"));
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

    case "x-agentlinkd.connectors.list":
      sendControl(client, "x-agentlinkd.connectors.list", mockConnectorsList());
      return;
    case "x-agentlinkd.connectors.authorize": {
      // Mock sign-in: a consent URL now, the token 1.5 s later (no browser round-trip).
      if (frame.kind !== "gdrive" && frame.kind !== "dropbox") { sendError(client, "bad_request", "unknown connector kind", frame.cmd); return; }
      const ticket = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
      MOCK_TICKETS.set(ticket, { kind: frame.kind, ready: false });
      broadcastControl("x-agentlinkd.connectors.authorize", { ticket, kind: frame.kind, url: `https://accounts.example/consent?mock=${ticket}` });
      setTimeout(() => { const t = MOCK_TICKETS.get(ticket); if (t) { t.ready = true; broadcastControl("x-agentlinkd.connectors.authorize", { ticket, done: true }); } }, 1500);
      return;
    }
    case "x-agentlinkd.connectors.relay":
      if (!MOCK_TICKETS.has(frame.ticket)) { sendError(client, "no_auth", "sign in first — the sign-in expired or was cancelled", frame.cmd); return; }
      sendControl(client, "x-agentlinkd.connectors.authorize", { ticket: frame.ticket, relayed: true });
      return;
    case "x-agentlinkd.connectors.cancel":
      MOCK_TICKETS.delete(frame.ticket);
      sendControl(client, "x-agentlinkd.connectors.authorize", { ticket: frame.ticket ?? null, cancelled: true });
      return;
    case "x-agentlinkd.connectors.add": {
      const label = typeof frame.label === "string" ? frame.label.trim() : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/.test(label) || typeof frame.remote !== "string") { sendError(client, "bad_request", "label: letters, numbers, spaces, . _ ( ) - (max 80)", frame.cmd); return; }
      if ([...MOCK_CONNECTORS.values()].some((c) => c.label.toLowerCase() === label.toLowerCase())) { sendError(client, "exists", "a connector or folder with that name already exists", frame.cmd); return; }
      if (frame.kind === "gdrive" || frame.kind === "dropbox") {
        const t = MOCK_TICKETS.get(frame.ticket);
        if (!t || !t.ready || t.kind !== frame.kind) { sendError(client, "no_auth", "sign in first — the sign-in expired or was cancelled", frame.cmd); return; }
        MOCK_TICKETS.delete(frame.ticket);
      }
      const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
      const c = { id, kind: frame.kind, label, remote: frame.kind === "github" && !frame.remote.startsWith("https://") ? `https://github.com/${frame.remote}` : frame.remote, local: `${MOCK_HOME}/Connected/${label}`, created: Date.now(), has_secret: !!frame.secret, status: "syncing" };
      MOCK_CONNECTORS.set(id, c);
      if (!MOCK_DIRS.has(`${MOCK_HOME}/Connected`)) { MOCK_DIRS.set(`${MOCK_HOME}/Connected`, { dirs: [], files: 0 }); MOCK_DIRS.get(MOCK_HOME).dirs.push("Connected"); }
      MOCK_DIRS.set(c.local, { dirs: [], files: 3 });
      MOCK_DIRS.get(`${MOCK_HOME}/Connected`).dirs.push(label);
      broadcastControl("x-agentlinkd.connectors.list", mockConnectorsList());
      setTimeout(() => { c.status = "idle"; c.last_sync = Date.now(); sendControl(client, "x-agentlinkd.connectors.list", mockConnectorsList({ added: id })); }, 600);
      return;
    }
    case "x-agentlinkd.connectors.sync":
    case "x-agentlinkd.connectors.push": {
      const c = MOCK_CONNECTORS.get(frame.id);
      if (!c) { sendError(client, "no_connector", "unknown connector", frame.cmd); return; }
      if (c.status === "syncing") { sendError(client, "busy", "that connector is already syncing", frame.cmd); return; }
      c.status = "syncing";
      broadcastControl("x-agentlinkd.connectors.list", mockConnectorsList());
      const key = frame.cmd.endsWith(".push") ? "pushed" : "synced";
      setTimeout(() => { c.status = "idle"; c.last_sync = Date.now(); sendControl(client, "x-agentlinkd.connectors.list", mockConnectorsList({ [key]: c.id })); }, 700);
      return;
    }
    case "x-agentlinkd.connectors.remove": {
      const c = MOCK_CONNECTORS.get(frame.id);
      if (!c) { sendError(client, "no_connector", "unknown connector", frame.cmd); return; }
      MOCK_CONNECTORS.delete(c.id);
      sendControl(client, "x-agentlinkd.connectors.list", mockConnectorsList({ removed: c.id }));
      return;
    }

    case "x-agentlinkd.auth.status":
      sendControl(client, "x-agentlinkd.auth.status", mockAuthStatus());
      return;
    case "x-agentlinkd.auth.login":
    case "x-agentlinkd.auth.logout": {
      if (!MOCK_AUTH.has(frame.provider)) { sendError(client, "bad_request", "unknown provider", frame.cmd); return; }
      if (frame.cmd.endsWith(".login") && (typeof frame.credential !== "string" || !frame.credential.trim())) { sendError(client, "bad_request", "paste the API key or token (single line)", frame.cmd); return; }
      MOCK_AUTH.set(frame.provider, frame.cmd.endsWith(".login") ? "key" : "none");
      broadcastControl("x-agentlinkd.auth.status", mockAuthStatus({ changed: frame.provider }));
      return;
    }

    case "x-agentlinkd.flows.list":
      sendControl(client, "x-agentlinkd.flows.list", { cwd: MOCK_HOME, flows: mockFlowList(), triggers: mockTriggers(), executor: "crew" });
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
      MOCK_FLOWS.set(f.name, { version: 1, name: f.name, title: f.title, desc: f.desc, nodes: f.nodes, edges: Array.isArray(f.edges) ? f.edges : [], triggers: Array.isArray(f.triggers) ? f.triggers : [] });
      sendControl(client, "x-agentlinkd.flows.put", { cwd: MOCK_HOME, flow: MOCK_FLOWS.get(f.name), bytes: JSON.stringify(f).length });
      broadcastControl("x-agentlinkd.flows.changed", { cwd: MOCK_HOME, flows: mockFlowList(), triggers: mockTriggers() });
      return;
    }
    case "x-agentlinkd.flows.delete":
      if (!MOCK_FLOWS.delete(frame.name)) sendError(client, "no_flow", `flow '${frame.name}': no_flow`, frame.cmd);
      else broadcastControl("x-agentlinkd.flows.changed", { cwd: MOCK_HOME, flows: mockFlowList(), triggers: mockTriggers() });
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

// ---------- session files + uploads (in-memory, dev parity) ----------

const MOCK_UPLOADS = new Map(); // "<session>/<rel>" -> { mime, buf }
const MOCK_FILE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".heif": "image/heif", ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".xml": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".tsv": "text/plain; charset=utf-8",
  ".rtf": "application/rtf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text", ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odp": "application/vnd.oasis.opendocument.presentation",
};

function mockSafeName(raw) {
  let n = String(raw ?? "").replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "";
  n = n.replace(/\p{C}/gu, "").replace(/^\.+/, "").trim().replace(/\s+/g, " ");
  if (!n || n === "." || n === "..") n = "file";
  return n.slice(0, 120);
}

function mockUniqueKey(sid, name) {
  const ext = name.includes(".") ? "." + name.split(".").pop() : "";
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= 999; i++) {
    const n = i === 1 ? name : `${stem}-${i}${ext}`;
    if (!MOCK_UPLOADS.has(`${sid}/uploads/${n}`)) return n;
  }
  return null;
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on("data", (d) => {
      n += d.length;
      if (n > cap) {
        req.pause(); // keep the socket so the 413 can still be written
        resolve(null);
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
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
  // Session-scoped files/upload/fetch over the in-memory store. Auth accepts
  // the header or ?t= (subresource loads cannot send headers).
  if (pathName.startsWith("/sessions/") && pathName !== "/sessions") {
    const q = new URL(req.url, "http://localhost");
    if (!requireAuth(req) && q.searchParams.get("t") !== TOKEN) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const parts = pathName.split("/").filter(Boolean); // sessions, id, verb, rel...
    const s = sessions.get(parts[1]);
    if (!s || parts.length < 3) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_session" }));
      return;
    }
    if (parts[2] === "file" && req.method === "GET") {
      let rel = q.searchParams.get("p");
      if (rel === null) {
        try {
          rel = parts.slice(3).map(decodeURIComponent).join("/");
        } catch {
          rel = "";
        }
      }
      rel = rel.replace(/^\/+/, "");
      const hit = MOCK_UPLOADS.get(`${s.id}/${rel}`);
      if (!hit) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no_file" }));
        return;
      }
      const download = /^(?:application\/(?:msword|rtf|vnd\.(?:ms-|openxmlformats-|oasis\.opendocument)))/.test(hit.mime);
      res.writeHead(200, {
        "content-type": hit.mime,
        "content-length": hit.buf.length,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        ...(hit.mime === "application/pdf" ? { "content-disposition": "inline" } : download ? { "content-disposition": "attachment" } : {}),
      });
      res.end(hit.buf);
      return;
    }
    if (parts[2] === "upload" && req.method === "POST" && parts.length === 3) {
      const rawName = q.searchParams.get("name") ?? "file";
      readBody(req, 8 * 1024 * 1024).then((buf) => {
        if (!buf) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "too_large" }));
          return;
        }
        const name = mockUniqueKey(s.id, mockSafeName(rawName));
        if (!name) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "exists" }));
          return;
        }
        const mime = MOCK_FILE_MIME[name.slice(name.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
        MOCK_UPLOADS.set(`${s.id}/uploads/${name}`, { mime, buf });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: `uploads/${name}`, bytes: buf.length, name, ...(mime !== "application/octet-stream" ? { type: mime } : {}) }));
      });
      return;
    }
    if (parts[2] === "fetch" && req.method === "POST" && parts.length === 3) {
      readBody(req, 8192).then((buf) => {
        let opts = null;
        try { opts = JSON.parse(buf.toString("utf8") || "{}"); } catch { /* below */ }
        if (!opts || typeof opts.url !== "string" || !opts.url.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_request", message: "url required" }));
          return;
        }
        // No network in the mock: the fetch lands as a stand-in note so the
        // chip/preview flow still works end to end in dev.
        let base = "";
        try { base = new URL(opts.url).pathname.split("/").filter(Boolean).pop() ?? ""; } catch { /* below */ }
        const file = mockUniqueKey(s.id, mockSafeName(opts.name || base || "fetched.txt"));
        const note = `DextUI mock fetch placeholder\nurl: ${opts.url}\nThe real host downloads this file; the mock records the request only.\n`;
        if (!file) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "exists" }));
          return;
        }
        MOCK_UPLOADS.set(`${s.id}/uploads/${file}`, { mime: "text/plain; charset=utf-8", buf: Buffer.from(note) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: `uploads/${file}`, bytes: Buffer.byteLength(note), name: file }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no_session" }));
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
