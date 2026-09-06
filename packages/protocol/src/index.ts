// AgentLink Protocol v1 — shared types and envelope helpers. Zero dependencies.
// Event tags and payload shapes mirror dext's AgentEvent (src/events.rs) exactly;
// host-synthesized events extend the stream without forking it.

export const PROTOCOL_VERSION = 1;

// ---------- dext primitives ----------

export interface Usage {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  cost_usd: number;
}

export interface ToolRef {
  call_id: string;
  name: string;
  summary: string;
}

export interface ToolResultEvent extends ToolRef {
  ok: boolean;
  preview: string;
  content: string;
}

export interface ToolOutputDeltaEvent {
  call_id: string;
  name: string;
  stream: string;
  text: string;
}

export interface ToolBatchStartEvent {
  batch_id: string;
  call_ids: string[];
  labels: string[];
}

export interface ToolBatchEndEvent extends ToolBatchStartEvent {
  failed: number;
}

export interface UsageUpdateEvent {
  turn: Usage;
  session: Usage;
}

export interface TurnDiagnosticsEvent {
  provider: string;
  api_family: string;
  auth_source: string;
  model: string;
  context_window?: number | null;
  last_retry_reason: string | null;
  workaround_fired: boolean;
  turn_duration_ms?: number | null;
  context_mode?: string | null;
  tool_profile?: string | null;
  compacted?: boolean | null;
}

export interface TurnEndEvent {
  usage: Usage;
  failed: boolean;
}

export interface HttpRetryEvent {
  attempt: number;
  wait_secs: number;
  reason: string;
}

export interface HistoryContextUpdatedEvent {
  chars: number;
  tokens?: number | null;
}

export interface RuntimeViewEvent {
  pack: string;
  title: string;
  markdown: string;
}

/** dext `pack_start`: a pack became active for this turn (explicit `--pack`
 *  or inferred from the prompt). Emitted once per activation, before any
 *  `runtime_view`. Hosts and clients prefer it over prompt-prefix guesses. */
export interface PackStartEvent {
  name: string;
  /** First 80 chars of the task. */
  task_preview: string;
}

export interface RuntimeControlAppliedEvent {
  commands: number;
  model_changed: boolean;
  effort_changed: boolean;
  mode_changed: boolean;
  stream_aborted: boolean;
}

export interface CompactEndEvent {
  before: number;
  after: number;
  summary: string;
}

export interface SteeringReceivedEvent {
  messages: number;
  preview: string;
}

export interface LocalAuthPromptEvent {
  tool: string;
  message: string;
}

// ---------- host-synthesized payloads ----------

export type SessionStatus = "cold" | "starting" | "live" | "exited";
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelGroup {
  provider: string;
  label?: string;
  models: string[];
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  /** Increments on clear, including across host restarts. */
  generation?: number;
  agent: { name: string; version: string };
  model?: string;
  provider?: string;
  thinking_effort?: ThinkingEffort;
  model_locked?: boolean;
  approval_profile?: string;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  last_seq: number;
  unread: number;
  pending_permissions: number;
}

/** Host-advertised slash command (composer completion is host-driven). */
export interface HostCommand {
  cmd: string;
  desc: string;
}

/** What a pack produces when it runs, as declared by its author. */
export type PackArtifact = "html" | "chart" | "table" | "markdown" | "file" | "none";

/** Gallery metadata, read by the host from flat `ui-*` keys in the pack's
 *  `PACK.md` front matter (dext ignores unknown keys) or from host defaults. */
export interface PackUi {
  starter_prompt: string;
  artifact: PackArtifact;
  /** Seconds to first visible artifact on the reference machine; 0 = unknown. */
  time_to_first_artifact: number;
  /** e.g. `approval:auto-write`, `chromium`, `connector:slack`. */
  requires: string[];
  gallery: boolean;
  tags: string[];
  icon?: string;
  /** Plain-language display name (≤ 48 chars); the pack `name` stays the id. */
  title?: string;
  /** Who the pack is for: `accountant` | `business` | `developer` | `everyone`.
   *  Empty means everyone. Drives the onboarding persona filter. */
  personas?: string[];
  /** Optional sandboxed HTML panel shipped inside the pack (relative path). */
  panel?: string;
  /** Pack-declared quick actions: label plus composer prompt. */
  actions?: { label: string; prompt: string }[];
}

/** One entry of the host's pack catalog (`hello_ok.packs`, `GET /packs`). */
export interface PackInfo {
  name: string;
  shelf?: string;
  description: string;
  /** `user:~/.dext/shelves/research`, `project:.dext/shelves/x`, `bundled` … */
  source: string;
  path: string;
  /** Pack Runtime Protocol descriptor (`runtime.json`) when the pack has a native runtime. */
  runtime?: string;
  ui: PackUi;
  /** Requirements the host could not satisfy right now (subset of `ui.requires`). */
  unmet: string[];
}

/** `GET /packs/:name`: metadata plus a shallow, read-only listing. */
export interface PackDetail extends PackInfo {
  files: { name: string; kind: "file" | "dir"; bytes?: number }[];
}

// ---------- pack file editing (host extension `x-agentlinkd.pack.*`) ----------

/** Extension prefix for the pack editor's confined read/write file surface. */
export const PACK_EXT = "x-agentlinkd.pack";

/** One entry of `x-agentlinkd.pack.files`: a recursive, relative-path listing.
 *  Dotfiles and symlinks never appear; `editable` mirrors the host's
 *  extension allowlist (md/json/ts/rs/… — never `bin/`). */
export interface PackFileEntry {
  path: string;
  kind: "file" | "dir";
  bytes?: number;
  editable?: boolean;
}

export interface PackFilesReply {
  pack: string;
  files: PackFileEntry[];
}

/** `x-agentlinkd.pack.file`: one editable file's full text (host cap 256 KB,
 *  non-text files are refused with a control error, never truncated). */
export interface PackFileReply {
  pack: string;
  path: string;
  bytes: number;
  text: string;
}

/** `x-agentlinkd.pack.write`: receipt for one saved file. The refreshed
 *  catalog follows separately via `packs.changed` (a PACK.md edit can change
 *  `ui-*` front matter and the `/pack` command list). */
export interface PackWriteReply {
  pack: string;
  path: string;
  bytes: number;
}

// ---------- flows (host extension `x-agentlinkd.flows.*`) ----------

/** Flow builder: a DAG of typed nodes saved at `<cwd>/.dext/flows/<name>.flow.json`;
 *  runs compile to a crew chain spec (crew is the executor). */
export const FLOWS_EXT = "x-agentlinkd.flows";

export type FlowNodeType = "pack" | "prompt" | "gate" | "message" | "condition";

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  label?: string;
  /** Canvas position (persisted; canvas-local). */
  x?: number;
  y?: number;
  /** pack: which pack to run. */
  pack?: string;
  /** pack: what the pack should do. */
  task?: string;
  /** prompt: the worker instruction (crew templates like {previous} pass through). */
  prompt?: string;
  agent?: string;
  model?: string;
  /** gate: the question the human answers (run pauses here). */
  question?: string;
  /** message: mesh recipient node name. */
  to?: string;
  text?: string;
  /** condition: continue when clearly true; escalate (pause) otherwise. */
  expr?: string;
}

export type FlowEdge = [string, string];

export interface FlowFile {
  version: 1;
  name: string;
  title?: string;
  desc?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** `x-agentlinkd.flows.list` entry. */
export interface FlowSummary {
  name: string;
  title: string;
  desc: string;
  nodes: number;
  edges: number;
  mtime: number;
}

export interface FlowsListReply {
  cwd: string;
  flows: FlowSummary[];
}

export interface FlowRunReply {
  cwd: string;
  name: string;
  spec_path?: string;
  started?: boolean;
  error?: string;
}

// ---------- folder picker (host extension `x-agentlinkd.dirs.*`) ----------

/** Confined folder browsing: `hello_ok.home` is the root; nothing outside it,
 *  no dot-directories, no symlinks is ever listed. */
export const DIRS_EXT = "x-agentlinkd.dirs";

export interface DirsListReply {
  path: string;
  /** Relative to `root` ("" at the root). */
  rel: string;
  parent: string | null;
  root: string;
  dirs: { name: string }[];
  /** Plain files in this folder (count only — the picker shows folders). */
  files: number;
  truncated: boolean;
  /** Set on the reply to `dirs.create`: the folder that was just made. */
  created?: string;
}

// ---------- self-edit (host extension `x-agentlinkd.ui.*` / `x-agentlinkd.host.*`) ----------

/** Extension prefixes for DextUI editing itself. Advertised as capability
 *  `self_edit` only when the host runs from a buildable checkout. */
export const SELF_UI_EXT = "x-agentlinkd.ui";
export const SELF_HOST_EXT = "x-agentlinkd.host";

/** Identity of a served build: vite's `sw.js?v=<id>` stamp, else the index mtime. */
export interface UiBuildVersion {
  id: string;
  mtime: number;
}

export interface UiBuildBrief {
  ok: boolean;
  id?: string;
  at: number;
  by: string;
  error?: string;
  failed?: string;
  rolled_back?: boolean;
  duration_ms?: number;
  version?: UiBuildVersion | null;
  steps?: { label: string; ok: boolean; duration_ms: number }[];
  /** Last ≤ 1200 chars of the failing step's output. */
  tail?: string;
}

export interface HostRestartRequest {
  reason: string;
  by: string;
  at: number;
}

/** `hello_ok.self`, `x-agentlinkd.ui.status`, `GET /__self`. */
export interface SelfStatus {
  enabled: boolean;
  /** DextUI checkout the host runs from (the workbench session's cwd). */
  repo: string;
  static: string;
  serving: "dist" | "lkg";
  version: UiBuildVersion | null;
  /** Last-known-good build kept beside `dist`, or null. */
  lkg: UiBuildVersion | null;
  building: { id: string; started_at: number; step: string; by: string } | null;
  last: UiBuildBrief | null;
  restart_pending: HostRestartRequest | null;
  restart_exit_code: number;
  /** Relative path of the build script the agent runs from bash. */
  build_script: string;
  /** Absolute path the agent writes to request a restart-when-idle. */
  request_file: string;
}

/** Broadcast progress of one build (`x-agentlinkd.ui.build`). */
export interface UiBuildEvent {
  id: string;
  phase: "start" | "step" | "ok" | "fail";
  by?: string;
  step?: string;
  duration_ms?: number;
  version?: UiBuildVersion | null;
  error?: string;
  failed?: string;
  tail?: string;
}

/** Broadcast after any dist swap — host build, rollback, or one the agent ran itself. */
export interface UiRebuiltEvent {
  version: UiBuildVersion | null;
  by: string;
  build?: string;
  rolled_back?: boolean;
}

/** Broadcast lifecycle of a host restart (`x-agentlinkd.host.restart`). */
export interface HostRestartEvent extends Partial<HostRestartRequest> {
  phase: "pending" | "restarting" | "cancelled";
  busy?: { kind: string; session?: string; run?: string; title?: string }[] | null;
  force?: boolean;
  exit_code?: number;
}

// ---------- crew runs (host extension `x-agentlinkd.crew.*`) ----------

/** Extension prefix. Host-prefixed per the `x-<host>.<thing>` rule until crew
 *  support is promoted to a standard extension. */
export const CREW_EXT = "x-agentlinkd.crew";

/** crew 0.1.0 `RunStatus` / `StepStatus`, verbatim (5 variants, no `stopped`). */
export type CrewStatus = "pending" | "running" | "completed" | "failed" | "paused";

/** Attention-sorted display state: crew's status plus the host-derived
 *  `stopped` (failed + `pausedReason == "stopped by user"` — a crew stopgap). */
export type CrewDisplayState = CrewStatus | "stopped";

export interface CrewCounts {
  pending: number;
  run: number;
  done: number;
  fail: number;
  paused: number;
  total: number;
}

/** The one human decision in a run. Present only while `status == "paused"`
 *  and a worker's `result.escalation` is set — never from `pausedReason` alone. */
export interface CrewEscalation {
  step: number;
  worker: string;
  label: string;
  question: string;
  reason?: string;
  file?: string;
}

/** Summary tier (`hello_ok.crews`, `x-agentlinkd.crew.changed`): ids, counts,
 *  wall clock — never worker prose. Flat in worker count. */
export interface CrewRunSummary {
  id: string;
  /** Root task, truncated by the host (120 chars). */
  task: string;
  status: CrewStatus;
  state: CrewDisplayState;
  mode: string;
  cwd: string;
  counts: CrewCounts;
  /** ms since the manifest was created. */
  age_ms: number;
  /** ms since the manifest last changed on disk. */
  updated_ms: number;
  /** Sum of finished worker durations (crew has no run-level timing). */
  duration_ms: number;
  detached: boolean;
  escalation?: CrewEscalation;
}

export interface CrewWorker {
  /** Stable key for tail/agent ids: `<groupIndex>` or `<groupIndex>.<memberIndex>`. */
  key: string;
  label: string;
  agent: string;
  status: CrewStatus;
  model?: string;
  duration_ms?: number;
  /** Unix ms; present while running (from the `.state` atom). */
  started_at?: number;
  /** Truncated to 80 chars at the host. */
  error?: string;
  /** Deliverable basename relative to the chain dir (what `x-agentlinkd.crew.file` accepts). */
  output?: string;
  escalation?: { question: string; reason?: string; file?: string };
}

export interface CrewGroup {
  index: number;
  kind: "sequential" | "parallel" | "dynamic";
  label: string;
  status: CrewStatus;
  counts: CrewCounts;
  workers: CrewWorker[];
}

/** Detail tier: one open sheet. Result text is still stripped — logs ride `tail`. */
export interface CrewRunDetail extends CrewRunSummary {
  created_at: number;
  paused_reason?: string;
  groups: CrewGroup[];
  /** Deliverables in the chain dir root (basenames). */
  files: string[];
}

export interface CrewsPayload {
  runs: CrewRunSummary[];
  /** Runs beyond the cap (8) — oldest terminal runs drop first. */
  omitted: number;
}

export interface CrewTailReply {
  run: string;
  worker: string;
  lines: string[];
  truncated: boolean;
  bytes: number;
}

export interface CrewFileReply {
  run: string;
  path: string;
  text: string;
  truncated: boolean;
  bytes: number;
}

/** Result of a control verb, broadcast so every client sees the same truth. */
export interface CrewControlEvent {
  run: string;
  verb: "stop" | "resume";
  ok: boolean;
  by?: string;
  message?: string;
}

export interface SessionConfiguredEvent {
  provider?: string;
  model?: string;
  thinking_effort?: ThinkingEffort;
  model_locked: boolean;
}

export interface PermissionRequestEvent {
  request_id: string;
  call_id?: string;
  tool: string;
  summary: string;
  input?: unknown;
  diff?: string;
  risk?: string;
}

export type PermissionChoice = "once" | "always" | "deny";

export interface PermissionResolvedEvent {
  request_id: string;
  choice: PermissionChoice;
  by: string;
}

/** Projection unit shared by snapshots and client stores. */
export type Block =
  | { kind: "text"; text: string; complete: boolean }
  | { kind: "thinking"; text: string; complete: boolean }
  | {
      kind: "tool";
      call_id: string;
      name: string;
      summary: string;
      status: "preview" | "running" | "ok" | "failed";
      content?: string;
      output_tail?: string;
    }
  | { kind: "user"; text: string; pack?: string }
  | { kind: "marker"; level: "info" | "warn" | "error" | "note"; text: string }
  | { kind: "slash"; text: string; structured: boolean }
  | { kind: "view"; pack: string; title: string; markdown: string };

export interface SnapshotEvent {
  meta: SessionMeta;
  blocks: Block[];
  pending_permissions: PermissionRequestEvent[];
  last_seq: number;
  /** Live turn state is projection metadata, not a journal event. */
  working?: boolean;
  turn_started_at?: number;
  turn_usage?: Usage;
  session_usage?: Usage;
  context_chars?: number;
  diagnostics?: TurnDiagnosticsEvent;
  compacting?: boolean;
  failed?: boolean;
  provider?: string;
  thinking_effort?: ThinkingEffort;
  model_locked?: boolean;
}

export interface SessionStateEvent {
  status: SessionStatus;
  detail?: string;
}

/** `session.delete_all` scope: every session, or only the ones not live. */
export type DeleteScope = "all" | "cold" | "exited";

/** Sent after `session.delete_all`; per-session `session.removed` precede it. */
export interface SessionsDeletedEvent {
  ids: string[];
  scope: DeleteScope;
}

// ---------- REST surfaces ----------

/** One dext todo item (`DEXT.todo.json` element shape, byte-compatible with dext's TUI reader). */
export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** `GET /sessions/:id/todos` (requires `todos_read`). */
export interface TodosResponse {
  session: string;
  /** Where the list came from: the session's own file, the project-level file, or nothing. */
  source: "session" | "project" | "none";
  path?: string;
  updated_at?: number;
  items: TodoItem[];
}

/** `GET /__agent`: bounded scene digest for supervising agents (<4 KiB target). */
export interface AgentDigest {
  server: string;
  instance?: string;
  now: number;
  capabilities: string[];
  sessions: {
    id: string;
    title: string;
    status: SessionStatus;
    working: boolean;
    model?: string;
    cwd?: string;
    last_seq: number;
    /** ms since the last journaled event, if any. */
    last_event_age_ms?: number;
    pending: { request_id: string; tool: string; summary: string }[];
  }[];
  /** Commands that are valid right now, in machine form (cmd + minimal payload). */
  actions: { cmd: string; session?: string; request_id?: string; run?: string; note?: string }[];
  /** Present when the `crew` capability is advertised. */
  crews?: CrewsPayload;
}

// ---------- event maps (documentation + exhaustiveness) ----------

/** dext AgentEvent pass-through (byte-identical to stream-json). */
export interface AgentEventMap {
  turn_start: undefined;
  history_context_updated: HistoryContextUpdatedEvent;
  text_delta: string;
  text_block_complete: string;
  thinking_delta: string;
  thinking_block_complete: string;
  tool_call_preview: ToolRef;
  tool_call_start: ToolRef;
  tool_call_result: ToolResultEvent;
  runtime_view: RuntimeViewEvent;
  tool_output_delta: ToolOutputDeltaEvent;
  local_auth_prompt: LocalAuthPromptEvent;
  login_input_mode: { provider?: string | null };
  tool_batch_start: ToolBatchStartEvent;
  tool_batch_end: ToolBatchEndEvent;
  usage_update: UsageUpdateEvent;
  http_retry: HttpRetryEvent;
  external_telemetry: { telemetry: Record<string, number> };
  turn_diagnostics: TurnDiagnosticsEvent;
  thinking_effort_changed: { effort: string };
  reasoning_mode_changed: { mode: string };
  approval_profile_changed: { profile: string };
  runtime_control: string;
  runtime_control_applied: RuntimeControlAppliedEvent;
  info: string;
  warn: string;
  error: string;
  slash: string;
  structured_slash: string;
  turn_end: TurnEndEvent;
  compact_start: undefined;
  compact_end: CompactEndEvent;
  compact_failed: { message: string };
  interrupted: undefined;
  steering_received: SteeringReceivedEvent;
}

/** Host-synthesized data plane. Snapshots are sequenced projections but are not appended to the journal. */
export interface HostEventMap {
  /** Journaled, monotonically sequenced host event. */
  user_message: { text: string };
  /** Sequenced point-in-time projection; not appended to the session journal. */
  "session.snapshot": SnapshotEvent;
  "session.state": SessionStateEvent;
  "session.configured": SessionConfiguredEvent;
  "permission.request": PermissionRequestEvent;
  "permission.resolved": PermissionResolvedEvent;
  "permission.already_resolved": { request_id: string };
  "permission.timeout": { request_id: string };
}

/** Control plane: unsequenced, unjournaled. */
export interface ControlEventMap {
  hello_ok: {
    server: string;
    version: string;
    protocol: number;
    capabilities: string[];
    sessions: SessionMeta[];
    /** Random per host process. A changed value on reconnect means the host
     *  restarted: journals may have been rebuilt, so clients resync from
     *  snapshots instead of resuming by seq. */
    instance?: string;
    model_catalog?: ModelGroup[];
    effort_options?: ThinkingEffort[];
    /** Slash commands the host handles; absent → client derives from `slash.*` caps. */
    commands?: HostCommand[];
    /** Pack catalog; present when the `packs` capability is advertised. */
    packs?: PackInfo[];
    /** Crew run summaries; present when the `crew` capability is advertised. */
    crews?: CrewsPayload;
  };
  hello_fail: { reason: string };
  "session.list": { sessions: SessionMeta[] };
  /** A session was deleted (by any client); stores, subscriptions, and local
   *  drafts for `id` should be dropped. `by` names the requesting client. */
  "session.removed": { id: string; by?: string };
  "session.cleared": { id: string; generation: number };
  "sessions.deleted": SessionsDeletedEvent;
  /** Full catalog replacement whenever a pack directory tree changes; the
   *  host's slash-command list rides along so `/` completion tracks new packs. */
  "packs.changed": { packs: PackInfo[]; commands?: HostCommand[] };
  /** Full summary replacement on any manifest change (debounced ~500 ms). */
  "x-agentlinkd.crew.changed": CrewsPayload;
  /** Detail snapshot for a run this client opened; re-sent on change while open. */
  "x-agentlinkd.crew.run": CrewRunDetail;
  /** Direct replies to `x-agentlinkd.crew.tail` / `.file`. */
  "x-agentlinkd.crew.tail": CrewTailReply;
  "x-agentlinkd.crew.file": CrewFileReply;
  /** Outcome of `.stop` / `.resume`, broadcast to every live client. */
  "x-agentlinkd.crew.control": CrewControlEvent;
  pong: Record<string, never>;
  /** `pack_requires_profile` carries `data.required` (the profile to switch to). */
  error: { code: string; message: string; data?: Record<string, unknown> };
}

export type DataEventTag = keyof AgentEventMap | keyof HostEventMap;
export type ControlEventTag = keyof ControlEventMap;

export interface Envelope<T = unknown> {
  v: number;
  session?: string;
  seq?: number;
  ts: number;
  event: string;
  data?: T;
}

// ---------- capabilities ----------

export const CAPABILITIES = [
  "approvals",
  "steering",
  "interrupt",
  "slash",
  "multi_session",
  "usage",
  "thinking",
  "model_select",
  "effort_select",
  "todos_read",
  /** Host honors session.delete / session.clear / session.delete_all. */
  "session_manage",
  /** Host advertises a pack catalog and runs `/pack run <name> <task>`. */
  "packs",
  /** Host projects crew runs (`hello_ok.crews`, `x-agentlinkd.crew.*`). */
  "crew",
] as const;

/** Client commands under the crew extension (`cmd: "x-agentlinkd.crew.<verb>"`). */
export const CREW_COMMANDS = ["open", "close", "tail", "file", "stop", "resume"] as const;
export const CREW_RUN_ID_RE = /^run-[a-f0-9]{12}$/;

// ---------- helpers ----------

export function wrapData(
  event: DataEventTag | string,
  session: string,
  seq: number,
  data?: unknown,
  ts: number = Date.now(),
): Envelope {
  const env: Envelope = { v: PROTOCOL_VERSION, session, seq, ts, event };
  if (data !== undefined) env.data = data;
  return env;
}

export function wrapControl(event: ControlEventTag | string, data?: unknown, ts: number = Date.now()): Envelope {
  const env: Envelope = { v: PROTOCOL_VERSION, ts, event };
  if (data !== undefined) env.data = data;
  return env;
}

/** Parse one raw dext stream-json / bridge line. Returns null on garbage. */
export function parseRawLine(line: string): { event: string; data?: unknown } | null {
  try {
    const v: unknown = JSON.parse(line);
    if (v && typeof v === "object" && typeof (v as { event?: unknown }).event === "string") {
      return v as { event: string; data?: unknown };
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a client command frame. */
export function cmd(name: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: PROTOCOL_VERSION, cmd: name, ...payload };
}

/** Routed to a session store when true. */
export function isSessionRouted(e: Envelope): boolean {
  return typeof e.session === "string";
}

/** Journaled (data plane) when true. */
export function isJournaled(e: Envelope): boolean {
  return typeof e.seq === "number";
}
