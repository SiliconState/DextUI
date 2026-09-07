// Per-session projection: folds the sequenced AgentLink event stream into blocks.
// Framework-free; the web app wraps this in a Svelte store.
//
// Rendering contract: `state.blocks` is replaced (new array) whenever any block
// changes, and a changed block is replaced by a new object with the same `id`.
// Unchanged blocks keep their reference, so keyed renderers re-render only the
// block that moved. Deltas therefore cost O(1) object work, not O(n).

import type {
  Block,
  CompactEndEvent,
  Envelope,
  HistoryContextUpdatedEvent,
  HttpRetryEvent,
  PackStartEvent,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  RuntimeControlAppliedEvent,
  RuntimeViewEvent,
  SessionConfiguredEvent,
  SessionMeta,
  SnapshotEvent,
  SteeringReceivedEvent,
  ToolBatchStartEvent,
  ToolOutputDeltaEvent,
  ToolRef,
  ToolResultEvent,
  ThinkingEffort,
  TurnDiagnosticsEvent,
  TurnEndEvent,
  UsageUpdateEvent,
} from "@dextui/protocol";

export interface PendingPermission extends PermissionRequestEvent {
  resolved?: { choice: string; by: string };
  timedOut?: boolean;
  /** Client receive time, for queue ordering across sessions. */
  received_at: number;
}

/** A projected block plus a client-stable identity for keyed rendering. */
export type ViewBlock = Block & { id: number };

export interface SessionState {
  id: string;
  title: string;
  cwd: string;
  status: SessionMeta["status"];
  lastSeq: number;
  blocks: ViewBlock[];
  toolIndex: Map<string, number>;
  pending: Map<string, PendingPermission>;
  working: boolean;
  turnStartedAt?: number;
  model?: string;
  provider?: string;
  thinkingEffort?: ThinkingEffort;
  reasoningMode?: string;
  modelLocked: boolean;
  /** Bumped by `todos.changed` (host push after todo_write); panels refetch. */
  todosVersion?: number;
  approvalProfile?: string;
  turnUsage?: UsageUpdateEvent["turn"];
  sessionUsage?: UsageUpdateEvent["session"];
  contextChars?: number;
  diagnostics?: TurnDiagnosticsEvent;
  telemetry?: Record<string, number>;
  /** Last provider retry seen during the current turn; cleared on turn_end. */
  retry?: HttpRetryEvent;
  /** Pack dext activated for the current turn (`pack_start`); cleared on turn_end. */
  activePack?: string;
  compacting: boolean;
  failed: boolean;
  /** Bounded raw envelope tail for the inspector (deltas excluded). */
  recent: Envelope[];
}

export type Listener = () => void;

const RECENT_CAP = 100;
const TAIL_CAP = 4000;
const DELTA_EVENTS = new Set(["text_delta", "thinking_delta", "tool_output_delta"]);

export class SessionStore {
  state: SessionState;
  private listeners = new Set<Listener>();
  private nextBlockId = 1;

  constructor(id: string) {
    this.state = {
      id,
      title: id,
      cwd: "",
      status: "cold",
      lastSeq: 0,
      blocks: [],
      toolIndex: new Map(),
      pending: new Map(),
      working: false,
      compacting: false,
      failed: false,
      modelLocked: false,
      recent: [],
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private bump<K extends keyof SessionState>(patch: Partial<Pick<SessionState, K>>): void {
    Object.assign(this.state, patch);
    this.emit();
  }

  private stamp(b: Block): ViewBlock {
    return { ...b, id: this.nextBlockId++ } as ViewBlock;
  }

  private pushBlock(b: Block): void {
    this.state.blocks = [...this.state.blocks, this.stamp(b)];
    this.emit();
  }

  /** Mid-stream annotation (steering ack, runtime control, info/warn): sits
   *  *before* a trailing open text/thinking block so the stream keeps
   *  accumulating into one block instead of splitting around the marker.
   *  Mirrors fold.mjs `annotate` (parity test). */
  private pushAnnotation(b: Block): void {
    const last = this.state.blocks[this.state.blocks.length - 1];
    if (last && (last.kind === "text" || last.kind === "thinking") && !last.complete) {
      const blocks = this.state.blocks.slice();
      blocks.splice(blocks.length - 1, 0, this.stamp(b));
      this.state.blocks = blocks;
      this.emit();
      return;
    }
    this.pushBlock(b);
  }

  /** Replace block `i` with `next` (keeping its id); new array, one new object. */
  private replaceBlock(i: number, next: Block): void {
    const prev = this.state.blocks[i];
    if (!prev) return;
    const blocks = this.state.blocks.slice();
    blocks[i] = { ...next, id: prev.id } as ViewBlock;
    this.state.blocks = blocks;
    this.emit();
  }

  private lastOpen(kind: "text" | "thinking"): number {
    const i = this.state.blocks.length - 1;
    const last = this.state.blocks[i];
    return last && last.kind === kind && !last.complete ? i : -1;
  }

  private appendStream(kind: "text" | "thinking", delta: string, ts: number): void {
    // A stream of one kind ends the other: providers may start text without an
    // explicit thinking_block_complete, and a still-"live" thinking block would
    // otherwise keep rendering its tail beside the reply until turn_end.
    this.sealOpenOf(kind === "text" ? "thinking" : "text");
    const i = this.lastOpen(kind);
    if (i < 0) {
      this.pushBlock({ kind, text: delta, complete: false, startedAt: ts });
      return;
    }
    const open = this.state.blocks[i] as Extract<ViewBlock, { kind: "text" | "thinking" }>;
    this.replaceBlock(i, { kind, text: open.text + delta, complete: false, startedAt: open.startedAt });
  }

  private completeStream(kind: "text" | "thinking", full: string, ts: number): void {
    this.sealOpenOf(kind === "text" ? "thinking" : "text");
    const i = this.lastOpen(kind);
    if (i < 0) this.pushBlock({ kind, text: full, complete: true, startedAt: ts, endedAt: ts });
    else {
      const open = this.state.blocks[i] as Extract<ViewBlock, { kind: "text" | "thinking" }>;
      this.replaceBlock(i, { kind, text: full, complete: true, startedAt: open.startedAt, endedAt: ts });
    }
  }

  private remember(e: Envelope): void {
    if (DELTA_EVENTS.has(e.event)) return;
    const recent = this.state.recent.length >= RECENT_CAP ? this.state.recent.slice(1) : this.state.recent.slice();
    recent.push(e);
    this.state.recent = recent;
  }

  apply(e: Envelope): void {
    if (typeof e.seq === "number") this.state.lastSeq = e.seq;
    this.remember(e);
    const d = e.data as never;
    switch (e.event) {
      // --- snapshots and state ---
      case "session.snapshot": {
        const s = d as SnapshotEvent;
        this.state.blocks = s.blocks.map((b) => this.stamp(b));
        this.state.toolIndex = new Map();
        this.state.blocks.forEach((b, i) => {
          if (b.kind === "tool") this.state.toolIndex.set(b.call_id, i);
        });
        const now = e.ts ?? Date.now();
        this.state.pending = new Map(s.pending_permissions.map((p) => [p.request_id, { ...p, received_at: now }]));
        this.bump({
          title: s.meta.title,
          cwd: s.meta.cwd,
          status: s.meta.status,
          lastSeq: s.last_seq,
          model: s.meta.model,
          provider: s.provider ?? s.meta.provider,
          thinkingEffort: s.thinking_effort ?? s.meta.thinking_effort,
          modelLocked: s.model_locked ?? s.meta.model_locked ?? false,
          approvalProfile: s.meta.approval_profile,
          working: s.working ?? false,
          compacting: s.compacting ?? false,
          failed: s.failed ?? false,
          turnStartedAt: s.working ? s.turn_started_at : undefined,
          turnUsage: s.turn_usage,
          sessionUsage: s.session_usage,
          contextChars: s.context_chars,
          diagnostics: s.diagnostics,
          retry: undefined,
        });
        return;
      }
      case "session.state": {
        const s = d as { status: SessionMeta["status"]; detail?: string };
        this.bump({ status: s.status });
        return;
      }
      case "session.configured": {
        const c = d as SessionConfiguredEvent;
        const patch: Partial<SessionState> = { modelLocked: c.model_locked };
        // Optional fields are patches, not replacements: an effort-only host
        // event must not erase the current provider/model projection.
        if (c.provider !== undefined) patch.provider = c.provider;
        if (c.model !== undefined) patch.model = c.model;
        if (c.thinking_effort !== undefined) patch.thinkingEffort = c.thinking_effort;
        this.bump(patch);
        return;
      }
      // --- turn lifecycle ---
      case "user_message":
        this.pushBlock({ kind: "user", text: (d as { text: string }).text });
        return;
      case "turn_start":
        this.bump({ working: true, failed: false, turnStartedAt: e.ts, retry: undefined });
        return;
      case "turn_end": {
        const t = d as TurnEndEvent;
        this.sealOpenBlocks();
        this.bump({
          working: false,
          failed: t.failed,
          turnStartedAt: undefined,
          sessionUsage: t.usage,
          retry: undefined,
          activePack: undefined,
        });
        return;
      }
      case "interrupted":
        this.sealOpenBlocks();
        this.bump({ working: false, turnStartedAt: undefined, retry: undefined });
        this.pushBlock({ kind: "marker", level: "warn", text: "Interrupted." });
        return;
      // --- text / thinking ---
      case "text_delta":
        this.appendStream("text", d as string, e.ts);
        return;
      case "text_block_complete":
        this.completeStream("text", d as string, e.ts);
        return;
      case "thinking_delta":
        this.appendStream("thinking", d as string, e.ts);
        return;
      case "thinking_block_complete":
        this.completeStream("thinking", d as string, e.ts);
        return;
      // --- tools ---
      case "tool_call_preview": {
        const t = d as ToolRef;
        this.mergeTool(t.call_id, { status: "preview" }, t);
        return;
      }
      case "tool_call_start": {
        const t = d as ToolRef;
        this.mergeTool(t.call_id, { status: "running" }, t);
        return;
      }
      case "tool_output_delta": {
        const o = d as ToolOutputDeltaEvent;
        const i = this.state.toolIndex.get(o.call_id);
        if (i === undefined) return;
        const b = this.state.blocks[i];
        if (b && b.kind === "tool") {
          this.replaceBlock(i, { ...b, output_tail: ((b.output_tail ?? "") + o.text).slice(-TAIL_CAP) });
        }
        return;
      }
      case "tool_call_result": {
        const t = d as ToolResultEvent;
        this.mergeTool(t.call_id, { status: t.ok ? "ok" : "failed", content: t.content }, t);
        return;
      }
      case "tool_batch_start": {
        const b = d as ToolBatchStartEvent;
        this.pushBlock({ kind: "marker", level: "note", text: `Batch: ${b.labels.join(" · ")}` });
        return;
      }
      case "tool_batch_end": {
        const b = d as { failed: number };
        if (b.failed > 0) this.pushBlock({ kind: "marker", level: "warn", text: `Batch: ${b.failed} tool call(s) failed.` });
        return;
      }
      // --- permissions ---
      case "permission.request": {
        const p = d as PermissionRequestEvent;
        this.state.pending = new Map(this.state.pending);
        this.state.pending.set(p.request_id, { ...p, received_at: e.ts ?? Date.now() });
        this.emit();
        return;
      }
      case "permission.resolved": {
        const r = d as PermissionResolvedEvent;
        const p = this.state.pending.get(r.request_id);
        if (p) {
          p.resolved = { choice: r.choice, by: r.by };
          this.state.pending = new Map(this.state.pending);
          this.state.pending.delete(r.request_id);
          this.pushBlock({
            kind: "marker",
            level: r.choice === "deny" ? "warn" : "info",
            text: `${p.tool}: ${r.choice}`,
          });
        }
        this.emit();
        return;
      }
      case "permission.timeout": {
        const t = d as { request_id: string };
        const p = this.state.pending.get(t.request_id);
        if (p) {
          p.timedOut = true;
          this.state.pending = new Map(this.state.pending);
          this.state.pending.delete(t.request_id);
          this.pushBlock({ kind: "marker", level: "warn", text: `${p.tool}: approval timed out (denied)` });
        }
        this.emit();
        return;
      }
      // --- meta ---
      case "usage_update": {
        const u = d as UsageUpdateEvent;
        this.bump({ turnUsage: u.turn, sessionUsage: u.session });
        return;
      }
      case "history_context_updated": {
        const h = d as HistoryContextUpdatedEvent;
        this.bump({ contextChars: h.chars });
        return;
      }
      case "turn_diagnostics": {
        const diag = d as TurnDiagnosticsEvent;
        this.bump({ diagnostics: diag, model: diag.model, provider: diag.provider });
        return;
      }
      case "thinking_effort_changed":
        this.bump({ thinkingEffort: (d as { effort: ThinkingEffort }).effort });
        return;
      case "reasoning_mode_changed": {
        const mode = (d as { mode: string }).mode;
        this.bump({ reasoningMode: mode });
        this.pushAnnotation({ kind: "marker", level: "note", text: `Reasoning mode → ${mode}` });
        return;
      }
      case "approval_profile_changed":
        this.bump({ approvalProfile: (d as { profile: string }).profile });
        return;
      case "http_retry": {
        const r = d as HttpRetryEvent;
        this.bump({ retry: r });
        this.pushAnnotation({ kind: "marker", level: "warn", text: `Provider retry #${r.attempt} in ${r.wait_secs}s: ${r.reason}` });
        return;
      }
      case "external_telemetry":
        this.bump({ telemetry: (d as { telemetry: Record<string, number> }).telemetry });
        return;
      case "runtime_control":
        this.pushAnnotation({ kind: "marker", level: "info", text: `Runtime control: ${String(d)}` });
        return;
      case "runtime_control_applied": {
        const a = d as RuntimeControlAppliedEvent;
        const parts: string[] = [];
        if (a.model_changed) parts.push("model");
        if (a.effort_changed) parts.push("effort");
        if (a.mode_changed) parts.push("mode");
        if (a.stream_aborted) parts.push("stream aborted");
        this.pushAnnotation({
          kind: "marker",
          level: a.stream_aborted ? "warn" : "note",
          text: `Runtime control applied (${a.commands} command${a.commands === 1 ? "" : "s"})${parts.length ? `: ${parts.join(", ")}` : ""}`,
        });
        return;
      }
      case "login_input_mode": {
        const l = d as { provider?: string | null };
        this.pushBlock({
          kind: "marker",
          level: "warn",
          text: `Login required${l?.provider ? ` for ${l.provider}` : ""} — complete it in the dext TUI.`,
        });
        return;
      }
      case "compact_start":
        this.bump({ compacting: true });
        return;
      case "compact_end": {
        const c = d as CompactEndEvent;
        this.bump({ compacting: false });
        this.pushBlock({ kind: "marker", level: "note", text: `Context compacted: ${c.before} → ${c.after} chars.` });
        return;
      }
      case "compact_failed":
        this.bump({ compacting: false });
        this.pushBlock({ kind: "marker", level: "warn", text: `Compaction failed: ${(d as { message: string }).message}` });
        return;
      // --- notices ---
      case "info":
        this.pushAnnotation({ kind: "marker", level: "info", text: d as string });
        return;
      case "warn":
        this.pushAnnotation({ kind: "marker", level: "warn", text: d as string });
        return;
      case "error":
        this.pushBlock({ kind: "marker", level: "error", text: d as string });
        return;
      case "slash":
        this.pushBlock({ kind: "slash", text: d as string, structured: false });
        return;
      case "structured_slash":
        this.pushBlock({ kind: "slash", text: d as string, structured: true });
        return;
      case "runtime_view": {
        const v = d as RuntimeViewEvent;
        this.pushBlock({ kind: "view", pack: v.pack, title: v.title, markdown: v.markdown });
        return;
      }
      case "pack_start": {
        // dext says which pack became active for this turn: stamp the turn's
        // prompt so attribution never depends on a `/pack run` prefix guess.
        const p = d as PackStartEvent;
        if (typeof p?.name !== "string" || !p.name) return;
        for (let i = this.state.blocks.length - 1; i >= 0; i--) {
          const b = this.state.blocks[i];
          if (b && b.kind === "user") {
            if (b.pack !== p.name) this.replaceBlock(i, { kind: "user", text: b.text, pack: p.name });
            break;
          }
        }
        this.bump({ activePack: p.name });
        return;
      }
      case "steering_received": {
        const s = d as SteeringReceivedEvent;
        this.pushAnnotation({ kind: "marker", level: "note", text: `Steering: ${s.preview}` });
        return;
      }
      case "steering_applied": {
        const s = d as SteeringReceivedEvent;
        this.pushAnnotation({ kind: "marker", level: "note", text: `Steering applied: ${s.preview}` });
        return;
      }
      case "todos.changed":
        this.bump({ todosVersion: (this.state.todosVersion ?? 0) + 1 });
        return;
      case "local_auth_prompt": {
        const l = d as { tool: string; message: string };
        this.pushBlock({ kind: "marker", level: "warn", text: `Credentials requested by ${l.tool}: ${l.message}` });
        return;
      }
      default:
        // Unknown/extension events (x-*) are kept in `recent` for the inspector.
        this.emit();
        return;
    }
  }

  /** End of turn (or interrupt): no streaming block may stay open. */
  private sealOpenBlocks(): void {
    this.sealOpenOf("text");
    this.sealOpenOf("thinking");
  }

  /** Seal the trailing open block of `kind`, if any (only the last block can be open). */
  private sealOpenOf(kind: "text" | "thinking"): void {
    let blocks: ViewBlock[] | undefined;
    this.state.blocks.forEach((b, i) => {
      if (b.kind === kind && !b.complete) {
        blocks ??= this.state.blocks.slice();
        blocks[i] = { ...b, complete: true };
      }
    });
    if (blocks) this.state.blocks = blocks;
  }

  /** Merge a tool lifecycle patch into the card keyed by call_id (create on first sight). */
  private mergeTool(
    callId: string,
    patch: Partial<Extract<Block, { kind: "tool" }>>,
    ref: ToolRef,
  ): void {
    const i = this.state.toolIndex.get(callId);
    if (i === undefined) {
      this.state.toolIndex.set(callId, this.state.blocks.length);
      this.pushBlock({
        kind: "tool",
        call_id: callId,
        name: ref.name,
        summary: ref.summary || "",
        status: "preview",
        ...patch,
      });
      return;
    }
    const prev = this.state.blocks[i];
    if (prev && prev.kind === "tool") {
      // Sticky name/summary: an event that omits them (or sends "") never clears
      // what an earlier event set — tool_call_preview often carries the only summary.
      this.replaceBlock(i, { ...prev, name: ref.name || prev.name, summary: ref.summary || prev.summary || "", ...patch });
    }
  }
}
