// Test-only entry used by header-review.vite.ts. Never imported by src/main.ts.
import { mount } from "svelte";
import { Connection } from "@dextui/client";
import type { Block, SessionMeta, ThinkingEffort } from "@dextui/protocol";
import "../src/app.css";
import App from "../src/App.svelte";
import { app, queue, setTheme } from "../src/lib/state.svelte";
import { openArtifact } from "../src/lib/artifact.svelte";
import { folders } from "../src/lib/folders.svelte";

const conn = new Connection({ url: "ws://127.0.0.1/unused", token: "fixture" });
conn.phase = "live";
conn.home = "/mock";
const store = conn.session("header-fixture");
const usage = { input: 80000, output: 1200, cache_create: 0, cache_read: 0, cost_usd: 0.1234 };
const long = "LongUnbrokenEvidenceName".repeat(10);
const report = '<!doctype html><html><body><h1>Fixture report</h1><p>No real session data.</p></body></html>';
const answer = `## Result ready\n\nAn answer with a long identifier: ${long}\n\n[Interactive result](./report.html)\n\n\`\`\`html\n${report}\n\`\`\`\n\n| ${long} | Value |\n|---|---|\n| ${long} | **Evidence** with \`code\` and ${long} |`;
let stateName = "done";
let auto = false;
let revision = 0;
const meta = (id = "header-fixture"): SessionMeta => ({ id, title: id === "header-fixture" ? `Daily market report · ${long}` : "Other fixture", cwd: `/mock/${long}`, status: "live", provider: "mock", model: "mock-model-with-a-long-name", agent: { name: "fixture", version: "1" }, created_at: 1, updated_at: Date.now(), last_seq: 1, unread: 0, pending_permissions: id === "header-fixture" && stateName === "review" ? 1 : 0, approval_profile: auto ? "always" : "ask", background_compact: true });

function set(state = stateName, fullAuto = auto, stress = false) {
  stateName = state;
  auto = fullAuto;
  app.statusDetailsOpen = false;
  app.contextOpen = false;
  app.sessionCtlOpen = false;
  app.settingsOpen = false;
  app.todosOpen = false;
  folders.open = false;
  app.activeId = "header-fixture";
  const m = meta();
  app.sessions = [m, meta("other-fixture")];
  const tool: Block = { kind: "tool", call_id: "fixture-tool", name: "bash", summary: `Rebuilding report · ${long}`, status: state === "working" || state === "review" ? "running" : state === "failed" ? "failed" : "ok", content: `exit: ${state === "failed" ? 1 : 0}\n--- stdout ---\n${long}\n--- stderr ---\n` };
  const blocks: Block[] = [{ kind: "user", text: `Review ${long}` }, tool];
  if (stress) {
    const tip = `[runtime-note] bash advisory: prefer native tools for ${long}; full guidance remains available.`;
    blocks.push(
      { kind: "marker", level: "info", text: "Batch: read_file: first fixture · bash: verify fixture" },
      { kind: "marker", level: "info", text: `[objective: Verify wrapping ${long} | checkpoints: check the card; preserve every step]` },
      { kind: "thinking", text: `Checking the long identifier ${long}.\n\n${long}`, complete: true },
      ...Array.from({ length: 30 }, (_, index): Block => ({ kind: "tool", call_id: `stress-${index}`, name: "bash", summary: `Verify ${index} ${long}`, status: index === 0 ? "failed" : "ok", content: `${long}\nEvidence stays inspectable.` })),
      { kind: "marker", level: "note", text: tip },
      { kind: "marker", level: "note", text: tip },
      { kind: "marker", level: "warn", text: "bash advisory: Keep this guidance inside work" },
      { kind: "marker", level: "warn", text: "Workspace policy warning remains visible" },
      { kind: "marker", level: "warn", text: "Batch: 1 tool call(s) failed." },
      { kind: "marker", level: "warn", text: "runtime guidance: objective checkpoints still look unresolved: log decisions and follow-up improvements. Before ending this turn, address them or explicitly say why each remaining item is not applicable / blocked." },
    );
  }
  if (state === "failed") blocks.push({ kind: "marker", level: "error", text: `Build failed. ${long}` });
  else if (state !== "working" && state !== "review") blocks.push({ kind: "text", text: answer, complete: true });
  const permission = { request_id: "fixture-approval", call_id: "fixture-tool", tool: "bash", summary: `Rebuild the local report ${long}`, input: { command: `npm run build -- ${long}` }, risk: "workspace changes" };
  store.apply({ v: 1, session: m.id, event: "session.snapshot", ts: Date.now(), data: { meta: m, blocks, pending_permissions: state === "review" ? [permission] : [], last_seq: ++revision, working: state === "working" || state === "review", failed: state === "failed", context_tokens: 80000, context_source: "request", session_usage: usage, turn_usage: usage, ui_progress: state === "working" ? [{ id: "p", pack: "report", request_id: "p", method: "progress", received_at: Date.now(), params: { id: "p", title: "Rebuilding report", message: "Rebuilding report", current: 5, total: 8, state: "running" } }] : [] } });
  queue.counts = state === "review" ? [{ id: m.id, title: m.title, count: 1 }] : [];
  app.runtimeRevision++;
}
function history() {
  set("done", false);
  const blocks: Block[] = [];
  for (let turn = 1; turn <= 70; turn++) {
    blocks.push(
      { kind: "user", text: `History request ${turn}: Review the weekly plan and keep the previous decisions.` },
      { kind: "text", text: `Checking the saved plan for turn ${turn}.`, complete: true },
      { kind: "tool", name: "read_file", call_id: `history-${turn}`, summary: "read_file: reports/weekly-plan.md", status: "ok", content: "Saved plan evidence." },
      { kind: "text", text: `### History answer ${turn}\n\nThe next step is clear: review the saved plan, check the numbers and keep the original workspace.\n\n- The report is ready to inspect.\n- No external actions were taken.\n\n\`\`\`sh\nprintf 'review only\\n'\n\`\`\`\n\n| Item | State |\n|---|---|\n| Saved plan | Ready |`, complete: true },
      { kind: "marker", level: "info", text: `Saved turn ${turn}; original files unchanged.` },
    );
  }
  // A realistic inline diff outside compacted tools exercises the modal itself.
  blocks.push({ kind: "compact", status: "complete", before: 40, after: 10, summary: "Summary ready.\n\n```text\nNothing was deleted.\n```" });
  blocks.push({ kind: "tool", name: "git_diff", call_id: "history-diff", status: "ok", summary: "git_diff: reports", content: "diff --git a/report.txt b/report.txt\n--- a/report.txt\n+++ b/report.txt\n@@ -1 +1 @@\n-old\n+new" });
  store.apply({ v: 1, session: store.state.id, event: "session.snapshot", ts: Date.now(), data: { meta: meta(), blocks, pending_permissions: [], working: false, failed: false, last_seq: ++revision } });
  app.runtimeRevision++;
}
function mixedWork() {
  set("working", false, true);
  event("tool_call_start", { call_id: "mixed-running", name: "bash", summary: "npm test" });
  event("tool_call_preview", { call_id: "mixed-pending", name: "read_file", summary: "reports/weekly-plan.md" });
  event("thinking_delta", "Checking the remaining evidence and current test results without changing the saved report.");
}
function event(event: string, data: unknown) {
  store.apply({ v: 1, session: store.state.id, event, ts: Date.now(), data });
  app.runtimeRevision++;
}
// Mutations in this fixture stay in memory, no real socket/host mutations.
conn.subscribe = (id) => { conn.subscribed.add(id); };
conn.unsubscribe = (id) => { conn.subscribed.delete(id); };
conn.configureSession = (_id, config) => {
  store.apply({ v: 1, session: store.state.id, event: "session.configured", ts: Date.now(), data: config });
};
conn.authStatus = () => {};
conn.dirsList = (path) => {
  folders.loading = false;
  folders.listing = { path, rel: path === "/mock" ? "" : path.slice(6), parent: path === "/mock" ? null : "/mock", root: "/mock", truncated: false, dirs: [{ name: "Reports", mtime: 1 }, { name: long, mtime: 1 }], files: 2 };
};
conn.slash = (_id, text) => {
  const approval = /^\/approval (\S+)$/.exec(text);
  if (approval) { auto = approval[1] === "always"; store.apply({ v: 1, session: store.state.id, event: "approval_profile_changed", ts: Date.now(), data: { profile: approval[1] } }); }
  return "";
};
conn.respond = () => { set("done", auto); };
app.conn = conn;
app.phase = "live";
app.caps = ["approvals", "steering", "slash.approval", "slash.compact", "model_select", "effort_select", "background_compaction_setting", "session_fork", "files_read", "todos_read", "dirs"];
app.modelCatalog = [{ provider: "mock", models: ["mock-model-with-a-long-name", "alternate-fixture-model"] }];
app.effortOptions = ["low", "medium", "high"] as ThinkingEffort[];
app.compactTools = true;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === "/sessions/header-fixture/todos") return new Response(JSON.stringify({ source: "fixture", path: "/mock/todos", items: [{ text: "Review the report", status: "completed" }, { text: "Check the sources and supporting tool output", status: "in_progress" }, { text: `Verify long identifiers ${long}`, status: "pending" }] }), { headers: { "content-type": "application/json" } });
  return nativeFetch(input, init);
};
set();
mount(App, { target: document.getElementById("app")! });
Object.assign(window, { __headerReview: { liveSteering: (value: boolean) => { app.caps = value ? [...app.caps, "steering.live"] : app.caps.filter((cap) => cap !== "steering.live"); }, requestForm: () => { event("ui.request", { id: "streaming-form", pack: "fixture", request_id: "form", method: "form", received_at: Date.now(), params: { title: "Streaming decision", submit_label: "Continue", fields: [{ id: "answer", label: "Your answer", type: "text" }] } }); }, set, history, mixedWork, event, context: (pct: number) => { store.state.diagnostics = { ...store.state.diagnostics, context_window: 200000 }; event("history_context_updated", { chars: pct * 2000 * 4, tokens: pct * 2000 }); }, model: (model: string, effort: ThinkingEffort) => { event("session.configured", { provider: model.startsWith("claude") ? "anthropic" : "openai", model, thinking_effort: effort }); }, phase: (phase: typeof app.phase) => { app.phase = phase; }, resetHost: () => { app.hostEpoch++; }, shareReport: () => openArtifact({ name: "fixture.html", html: report, sessionId: store.state.id }), needsToken: (value: boolean) => { app.needsToken = value; }, stress: () => set("done", false, true), theme: setTheme, long, setNoContext: () => { store.state.contextTokens = undefined; store.state.contextChars = undefined; store.apply({ v: 1, session: store.state.id, event: "info", ts: Date.now(), data: "Context unavailable" }); }, other: () => { app.activeId = "other-fixture"; }, back: () => { app.activeId = "header-fixture"; } } });
