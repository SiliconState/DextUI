// Per-session projection: folds the sequenced AgentLink event stream into blocks.
// Framework-free; the web app wraps this in a Svelte store.

import type {
  Block,
  CompactEndEvent,
  Envelope,
  HistoryContextUpdatedEvent,
  PermissionRequestEvent,
  PermissionResolvedEvent,
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
}

export interface SessionState {
  id: string;
  title: string;
  cwd: string;
  status: SessionMeta["status"];
  lastSeq: number;
  blocks: Block[];
  toolIndex: Map<string, number>;
  pending: Map<string, PendingPermission>;
  working: boolean;
  turnStartedAt?: number;
  model?: string;
  provider?: string;
  thinkingEffort?: ThinkingEffort;
  modelLocked: boolean;
  approvalProfile?: string;
  turnUsage?: UsageUpdateEvent["turn"];
  sessionUsage?: UsageUpdateEvent["session"];
  contextChars?: number;
  diagnostics?: TurnDiagnosticsEvent;
  compacting: boolean;
  failed: boolean;
}

export type Listener = () => void;

export class SessionStore {
  state: SessionState;
  private listeners = new Set<Listener>();

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

  private pushBlock(b: Block): void {
    this.state.blocks.push(b);
    this.emit();
  }

  private openBlock(kind: "text" | "thinking"): Extract<Block, { kind: typeof kind }> | undefined {
    const last = this.state.blocks[this.state.blocks.length - 1];
    if (last && last.kind === kind && !last.complete) return last as never;
    return undefined;
  }

  apply(e: Envelope): void {
    if (typeof e.seq === "number") this.state.lastSeq = e.seq;
    const d = e.data as never;
    switch (e.event) {
      // --- snapshots and state ---
      case "session.snapshot": {
        const s = d as SnapshotEvent;
        this.state.blocks = s.blocks;
        this.state.toolIndex = new Map();
        s.blocks.forEach((b, i) => {
          if (b.kind === "tool") this.state.toolIndex.set(b.call_id, i);
        });
        this.state.pending = new Map(s.pending_permissions.map((p) => [p.request_id, { ...p }]));
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
        this.bump({ working: true, failed: false, turnStartedAt: e.ts });
        return;
      case "turn_end": {
        const t = d as TurnEndEvent;
        this.sealOpenBlocks();
        this.bump({
          working: false,
          failed: t.failed,
          turnStartedAt: undefined,
          sessionUsage: t.usage,
        });
        return;
      }
      case "interrupted":
        this.sealOpenBlocks();
        this.bump({ working: false, turnStartedAt: undefined });
        this.pushBlock({ kind: "marker", level: "warn", text: "Interrupted." });
        return;
      // --- text / thinking ---
      case "text_delta": {
        const open = this.openBlock("text");
        if (open) {
          open.text += d as string;
          this.emit();
        } else {
          this.pushBlock({ kind: "text", text: d as string, complete: false });
        }
        return;
      }
      case "text_block_complete": {
        const open = this.openBlock("text");
        if (open) {
          open.text = d as string;
          open.complete = true;
          this.emit();
        } else {
          this.pushBlock({ kind: "text", text: d as string, complete: true });
        }
        return;
      }
      case "thinking_delta": {
        const open = this.openBlock("thinking");
        if (open) {
          open.text += d as string;
          this.emit();
        } else {
          this.pushBlock({ kind: "thinking", text: d as string, complete: false });
        }
        return;
      }
      case "thinking_block_complete": {
        const open = this.openBlock("thinking");
        if (open) {
          open.text = d as string;
          open.complete = true;
          this.emit();
        } else {
          this.pushBlock({ kind: "thinking", text: d as string, complete: true });
        }
        return;
      }
      // --- tools ---
      case "tool_call_preview": {
        const t = d as ToolRef;
        this.pushBlock({ kind: "tool", call_id: t.call_id, name: t.name, summary: t.summary, status: "preview" });
        // Register so a later tool_call_start/result merges into this block
        // instead of pushing a duplicate card.
        this.state.toolIndex.set(t.call_id, this.state.blocks.length - 1);
        return;
      }
      case "tool_call_start": {
        const t = d as ToolRef;
        this.mergeTool(t.call_id, {
          kind: "tool",
          call_id: t.call_id,
          name: t.name,
          summary: t.summary,
          status: "running",
        });
        return;
      }
      case "tool_output_delta": {
        const o = d as ToolOutputDeltaEvent;
        const i = this.state.toolIndex.get(o.call_id);
        if (i !== undefined) {
          const b = this.state.blocks[i];
          if (b && b.kind === "tool") {
            b.output_tail = ((b.output_tail ?? "") + o.text).slice(-4000);
            this.emit();
          }
        }
        return;
      }
      case "tool_call_result": {
        const t = d as ToolResultEvent;
        this.mergeTool(t.call_id, {
          kind: "tool",
          call_id: t.call_id,
          name: t.name,
          summary: t.summary,
          status: t.ok ? "ok" : "failed",
          content: t.content,
        });
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
        this.state.pending.set(p.request_id, { ...p });
        this.emit();
        return;
      }
      case "permission.resolved": {
        const r = d as PermissionResolvedEvent;
        const p = this.state.pending.get(r.request_id);
        if (p) {
          p.resolved = { choice: r.choice, by: r.by };
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
      case "approval_profile_changed":
        this.bump({ approvalProfile: (d as { profile: string }).profile });
        return;
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
        this.pushBlock({ kind: "marker", level: "info", text: d as string });
        return;
      case "warn":
      case "error":
        this.pushBlock({ kind: "marker", level: e.event as "warn" | "error", text: d as string });
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
      case "steering_received": {
        const s = d as SteeringReceivedEvent;
        this.pushBlock({ kind: "marker", level: "note", text: `Steering: ${s.preview}` });
        return;
      }
      case "local_auth_prompt": {
        const l = d as { tool: string; message: string };
        this.pushBlock({ kind: "marker", level: "warn", text: `Credentials requested by ${l.tool}: ${l.message}` });
        return;
      }
      default:
        // http_retry, external_telemetry, runtime_control*, login_input_mode,
        // thinking_effort_changed, reasoning_mode_changed: surfaced later in the inspector.
        return;
    }
  }

  /** End of turn (or interrupt): no streaming block may stay open. */
  private sealOpenBlocks(): void {
    for (const b of this.state.blocks) {
      if ((b.kind === "text" || b.kind === "thinking") && !b.complete) b.complete = true;
    }
  }

  private mergeTool(callId: string, next: Extract<Block, { kind: "tool" }>): void {
    const i = this.state.toolIndex.get(callId);
    if (i === undefined) {
      this.state.toolIndex.set(callId, this.state.blocks.length);
      this.pushBlock(next);
      return;
    }
    const prev = this.state.blocks[i];
    if (prev && prev.kind === "tool") {
      Object.assign(prev, next, { output_tail: prev.output_tail ?? next.output_tail });
      this.emit();
    }
  }
}
