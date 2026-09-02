// AgentLink client: WebSocket lifecycle, hello auth, seq-resume, reconnect.
// Framework-free and dependency-free; runs in browsers and Node 22+ (global WebSocket).

import {
  cmd,
  isSessionRouted,
  PROTOCOL_VERSION,
  type Envelope,
  type HostCommand,
  type ModelGroup,
  type SessionMeta,
  type ThinkingEffort,
} from "@dextui/protocol";
import { SessionStore } from "./session.js";

export type ConnPhase = "connecting" | "authing" | "live" | "reconnecting" | "closed" | "failed";

export interface ConnectionOpts {
  url: string; // ws:// or wss://…/ws
  token: string;
  client?: string;
  onPhase?: (phase: ConnPhase, detail?: string) => void;
  onSessionList?: (sessions: SessionMeta[]) => void;
  onControlError?: (code: string, message: string) => void;
  onSeqGap?: (sessionId: string, expected: number, got: number) => void;
  /** The host process changed between connections; all session stores were reset. */
  onHostRestart?: (instance: string) => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

export class Connection {
  phase: ConnPhase = "connecting";
  capabilities: string[] = [];
  modelCatalog: ModelGroup[] = [];
  effortOptions: ThinkingEffort[] = [];
  commands: HostCommand[] = [];
  /** Host process identity from the last hello_ok (undefined for legacy hosts). */
  instance?: string;
  sessions = new Map<string, SessionStore>();
  /** Sessions this client wants a live tail for; re-attached after every reconnect. */
  subscribed = new Set<string>();
  private ws?: WebSocket;
  private opts: ConnectionOpts;
  private attempt = 0;
  private closedByUser = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private resyncPending = new Set<string>();
  private controlListeners = new Set<(e: Envelope) => void>();
  private everLive = false;

  constructor(opts: ConnectionOpts) {
    this.opts = opts;
  }

  connect(): void {
    // A manual connect() after close() must re-arm the reconnect path.
    this.closedByUser = false;
    this.setPhase(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.setPhase("authing");
      this.sendRaw(cmd("hello", { token: this.opts.token, client: this.opts.client ?? "dextui", protocol: PROTOCOL_VERSION }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let env: Envelope;
      try {
        env = JSON.parse(ev.data) as Envelope;
      } catch {
        return;
      }
      this.route(env);
    };
    ws.onclose = () => {
      this.clearPing();
      if (this.closedByUser) {
        // hello_fail already published "failed" — don't downgrade it to "closed".
        if (this.phase !== "failed") this.setPhase("closed");
        return;
      }
      this.attempt += 1;
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 5));
      this.setPhase("reconnecting", `retry in ${Math.round(wait / 1000)}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.closedByUser) this.connect();
      }, wait);
    };
    ws.onerror = () => {
      // onclose follows; handled there.
    };
  }

  close(): void {
    this.closedByUser = true;
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
    // During backoff the socket is already CLOSED, so no onclose callback will
    // arrive to publish the final phase.
    if (this.phase !== "failed") this.setPhase("closed");
  }

  onControl(fn: (e: Envelope) => void): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  session(id: string): SessionStore {
    let s = this.sessions.get(id);
    if (!s) {
      s = new SessionStore(id);
      this.sessions.set(id, s);
    }
    return s;
  }

  // ---------- commands ----------

  sendRaw(frame: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  openSession(opts: { id?: string; cwd?: string; seat?: string } = {}): void {
    this.sendRaw(cmd("session.open", { ...opts }));
  }

  /**
   * Attach to a session's live tail. Resumes by seq when the store already
   * holds history from this host instance; `fresh` forces a snapshot.
   */
  subscribe(id: string, fresh = false): void {
    const s = this.session(id);
    this.subscribed.add(id);
    this.sendRaw(cmd("session.subscribe", { id, since_seq: fresh ? undefined : s.state.lastSeq || undefined }));
  }

  unsubscribe(id: string): void {
    this.subscribed.delete(id);
    this.sendRaw(cmd("session.unsubscribe", { id }));
  }

  prompt(sessionId: string, text: string): void {
    this.sendRaw(cmd("prompt.submit", { session: sessionId, text }));
  }

  steer(sessionId: string, text: string): void {
    this.sendRaw(cmd("steering.inject", { session: sessionId, text }));
  }

  interrupt(sessionId: string): void {
    this.sendRaw(cmd("interrupt", { session: sessionId }));
  }

  respond(sessionId: string, requestId: string, choice: "once" | "always" | "deny", note?: string): void {
    this.sendRaw(cmd("permission.respond", { session: sessionId, request_id: requestId, choice, note }));
  }

  slash(sessionId: string, raw: string): void {
    this.sendRaw(cmd("slash", { session: sessionId, raw }));
  }

  configureSession(
    id: string,
    patch: { provider?: string; model?: string; thinking_effort?: ThinkingEffort },
  ): void {
    this.sendRaw(cmd("session.configure", { id, ...patch }));
  }

  renameSession(id: string, title: string): void {
    this.sendRaw(cmd("session.rename", { id, title }));
  }

  closeSession(id: string): void {
    this.sendRaw(cmd("session.close", { id }));
  }

  hasCap(cap: string): boolean {
    return this.capabilities.includes(cap);
  }

  // ---------- routing ----------

  private route(env: Envelope): void {
    // Agent/drive affordance: observable envelope counters on window.
    if (typeof window !== "undefined") {
      const w = window as unknown as {
        __agentlink?: { total: number; byEvent: Record<string, number>; last?: unknown };
      };
      w.__agentlink = w.__agentlink ?? { total: 0, byEvent: {} };
      w.__agentlink.total++;
      w.__agentlink.byEvent[env.event] = (w.__agentlink.byEvent[env.event] ?? 0) + 1;
      w.__agentlink.last = { event: env.event, session: env.session, seq: env.seq };
    }
    if (isSessionRouted(env)) {
      const sessionId = env.session as string;
      const store = this.session(sessionId);
      if (env.event !== "session.snapshot" && typeof env.seq === "number") {
        // Idempotence: reconnect replays and races can deliver an already-folded
        // envelope. Reapplying it would duplicate user/text/marker blocks.
        if (env.seq <= store.state.lastSeq) return;
        const expected = store.state.lastSeq + 1;
        if (this.resyncPending.has(sessionId)) return; // quarantine until snapshot
        if (env.seq > expected && store.state.lastSeq > 0) {
          this.resyncPending.add(sessionId);
          this.opts.onSeqGap?.(sessionId, expected, env.seq);
          this.sendRaw(cmd("session.subscribe", { id: sessionId }));
          return; // never apply an event across a known gap
        }
      }
      if (env.event === "session.snapshot") this.resyncPending.delete(sessionId);
      store.apply(env);
      return;
    }
    switch (env.event) {
      case "hello_ok": {
        const d = env.data as {
          capabilities: string[];
          sessions: SessionMeta[];
          instance?: string;
          model_catalog?: ModelGroup[];
          effort_options?: ThinkingEffort[];
          commands?: HostCommand[];
        };
        this.capabilities = d.capabilities;
        this.modelCatalog = d.model_catalog ?? [];
        this.effortOptions = d.effort_options ?? [];
        this.commands = d.commands ?? [];
        this.attempt = 0;
        // A different host process may reuse session ids and even tail seqs;
        // resuming by seq would splice the old transcript onto the new one.
        // Legacy hosts (no instance) are treated as restarted on every reconnect.
        const restarted = this.instance !== undefined && d.instance !== this.instance;
        const legacyReconnect = d.instance === undefined && this.everLive;
        this.instance = d.instance;
        if (restarted || legacyReconnect) {
          this.sessions.clear();
          this.resyncPending.clear();
          this.opts.onHostRestart?.(d.instance ?? "");
        }
        this.everLive = true;
        this.setPhase("live");
        this.startPing();
        this.opts.onSessionList?.(d.sessions);
        // Re-attach every wanted tail. Sessions the host no longer lists are
        // dropped rather than producing a no_session error per reconnect.
        const known = new Set(d.sessions.map((s) => s.id));
        for (const id of [...this.subscribed]) {
          if (!known.has(id)) {
            this.subscribed.delete(id);
            continue;
          }
          this.subscribe(id, restarted || legacyReconnect);
        }
        break;
      }
      case "hello_fail": {
        const d = env.data as { reason: string };
        this.closedByUser = true;
        this.setPhase("failed", d.reason);
        this.ws?.close();
        return;
      }
      case "session.list": {
        const d = env.data as { sessions: SessionMeta[] };
        this.opts.onSessionList?.(d.sessions);
        break;
      }
      case "pong":
        return;
      case "error": {
        const d = env.data as { code: string; message: string };
        this.opts.onControlError?.(d.code, d.message);
        break;
      }
      default:
        break;
    }
    for (const fn of this.controlListeners) fn(env);
  }

  private setPhase(p: ConnPhase, detail?: string): void {
    this.phase = p;
    this.opts.onPhase?.(p, detail);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => this.sendRaw(cmd("ping")), PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
