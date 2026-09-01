// AgentLink client: WebSocket lifecycle, hello auth, seq-resume, reconnect.
// Framework-free and dependency-free; runs in browsers and Node 22+ (global WebSocket).

import { cmd, isSessionRouted, PROTOCOL_VERSION, type Envelope, type SessionMeta } from "@dextui/protocol";
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
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

export class Connection {
  phase: ConnPhase = "connecting";
  capabilities: string[] = [];
  sessions = new Map<string, SessionStore>();
  private ws?: WebSocket;
  private opts: ConnectionOpts;
  private attempt = 0;
  private closedByUser = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private controlListeners = new Set<(e: Envelope) => void>();

  constructor(opts: ConnectionOpts) {
    this.opts = opts;
  }

  connect(): void {
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
        this.setPhase("closed");
        return;
      }
      this.attempt += 1;
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 5));
      this.setPhase("reconnecting", `retry in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {
      // onclose follows; handled there.
    };
  }

  close(): void {
    this.closedByUser = true;
    this.clearPing();
    this.ws?.close();
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

  subscribe(id: string): void {
    const s = this.session(id);
    this.sendRaw(cmd("session.subscribe", { id, since_seq: s.state.lastSeq || undefined }));
  }

  unsubscribe(id: string): void {
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
      const store = this.session(env.session as string);
      if (typeof env.seq === "number") {
        const expected = store.state.lastSeq + 1;
        if (env.seq > expected && store.state.lastSeq > 0 && env.event !== "session.snapshot") {
          this.opts.onSeqGap?.(env.session as string, expected, env.seq);
          // Resync of last resort: fresh snapshot.
          this.sendRaw(cmd("session.subscribe", { id: env.session }));
        }
      }
      store.apply(env);
      return;
    }
    switch (env.event) {
      case "hello_ok": {
        const d = env.data as { capabilities: string[]; sessions: SessionMeta[] };
        this.capabilities = d.capabilities;
        this.attempt = 0;
        this.setPhase("live");
        this.startPing();
        this.opts.onSessionList?.(d.sessions);
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
