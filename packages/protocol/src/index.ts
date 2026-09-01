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
  | { kind: "user"; text: string }
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
    model_catalog?: ModelGroup[];
    effort_options?: ThinkingEffort[];
  };
  hello_fail: { reason: string };
  "session.list": { sessions: SessionMeta[] };
  pong: Record<string, never>;
  error: { code: string; message: string };
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
] as const;

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
