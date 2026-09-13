// AgentLink client: WebSocket lifecycle, hello auth, seq-resume, reconnect.
// Framework-free and dependency-free; runs in browsers and Node 22+ (global WebSocket).

import {
  cmd,
  isSessionRouted,
  AUTH_EXT,
  CONNECTORS_EXT,
  CREW_EXT,
  DIRS_EXT,
  FLOWS_EXT,
  PACK_CREDENTIALS_EXT,
  PACK_EXT,
  SELF_HOST_EXT,
  SELF_UI_EXT,
  TASKS_EXT,
  PROTOCOL_VERSION,
  type Envelope,
  type CrewsPayload,
  type DeleteScope,
  type HostCommand,
  type ModelGroup,
  type PackInfo,
  type SelfStatus,
  type FlowFile,
  type SessionMeta,
  type TaskRecord,
  type ThinkingEffort,
  type ConnectorKind,
} from "@dextui/protocol";
import { SessionStore } from "./session.js";

export type ConnPhase = "connecting" | "authing" | "live" | "reconnecting" | "closed" | "failed";

export interface ConnectionOpts {
  url: string; // ws:// or wss://…/ws
  token: string;
  client?: string;
  onPhase?: (phase: ConnPhase, detail?: string) => void;
  onSessionList?: (sessions: SessionMeta[]) => void;
  onSessionRemoved?: (id: string) => void;
  onSessionCleared?: (id: string, generation: number) => void;
  /** Full catalog replacement (hello_ok and every packs.changed). */
  onPacksChanged?: (packs: PackInfo[]) => void;
  /** Crew run summaries (hello_ok.crews and every x-agentlinkd.crew.changed). */
  onCrewsChanged?: (crews: CrewsPayload) => void;
  /** Self-edit status (hello_ok.self and every x-agentlinkd.ui.status reply). */
  onSelfChanged?: (self: SelfStatus) => void;
  onControlError?: (code: string, message: string, data?: Record<string, unknown>) => void;
  /** Delivery outcome for a command sent with a nonce (prompt/steer/slash).
   *  `ok: false` covers host rejection and outbox expiry; `duplicate: true`
   *  means the host had already run this nonce (reconnect replay);
   *  `durable: false` means the host accepted the turn but its journal
   *  append failed (persistence degraded, not delivery). */
  onCmdAck?: (nonce: string, ok: boolean, info: { cmd: string; duplicate?: boolean; durable?: boolean; message?: string }) => void;
  onSeqGap?: (sessionId: string, expected: number, got: number) => void;
  /** The host process changed between connections; all session stores were reset. */
  onHostRestart?: (instance: string) => void;
  /** Every data-plane envelope, after it has been folded into its store. */
  onEvent?: (env: Envelope, store: SessionStore) => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
/** No pong for three intervals = half-dead socket (NAT timeout, vanished
 *  peer): close it and let the ordinary onclose path reconnect + replay. */
const PONG_DEADLINE_MS = 3 * PING_INTERVAL_MS;
/** Queued sends and unacked nonces older than this are reported failed. */
const OUTBOX_TTL_MS = 120_000;
const OUTBOX_MAX = 32;

let nonceCounter = 0;
function newNonce(): string {
  nonceCounter += 1;
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g && typeof g.randomUUID === "function") return g.randomUUID();
  return `n-${Date.now().toString(36)}-${nonceCounter.toString(36)}`;
}

export class Connection {
  phase: ConnPhase = "connecting";
  capabilities: string[] = [];
  modelCatalog: ModelGroup[] = [];
  effortOptions: ThinkingEffort[] = [];
  commands: HostCommand[] = [];
  packs: PackInfo[] = [];
  /** Last crew summary payload from the host (empty when the capability is absent). */
  crews: CrewsPayload = { runs: [], omitted: 0 };
  /** Self-edit status; null on hosts without the `self_edit` capability. */
  self: SelfStatus | null = null;
  /** Folder-picker root (`hello_ok.home`); empty on hosts without `dirs`. */
  home = "";
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
  /** Last pong (or heartbeat start): silence past PONG_DEADLINE_MS kills the socket. */
  private lastPongAt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private resyncPending = new Set<string>();
  private controlListeners = new Set<(e: Envelope) => void>();
  private everLive = false;
  private metadata = new Map<string, SessionMeta>();
  private removed = new Set<string>();
  /** Frames typed while the socket was down, replayed verbatim (same nonce)
   *  after hello_ok — the host dedups by nonce, so replay never double-runs. */
  private outbox: { frame: Record<string, unknown>; at: number }[] = [];
  /** Nonces of prompt/steer/slash frames awaiting a host `cmd_ack`. */
  private pendingAcks = new Map<string, { cmd: string; at: number }>();

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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return;
    }
    // Socket down: hold a bounded outbox so input typed during a drop is
    // delivered once the connection returns (same nonce → host-side dedup).
    const now = Date.now();
    this.outbox = this.outbox.filter((f) => now - f.at < OUTBOX_TTL_MS);
    if (this.outbox.length >= OUTBOX_MAX) {
      const df = this.outbox.shift()?.frame;
      // Never silently drop: a nonce-tagged frame is reported as failed
      // delivery so its sender can restore the text and retry deliberately.
      const dn = typeof df?.nonce === "string" ? df.nonce : "";
      if (df && dn && this.pendingAcks.has(dn)) {
        this.pendingAcks.delete(dn);
        this.opts.onCmdAck?.(dn, false, { cmd: String(df.cmd ?? ""), message: "not sent — the offline queue was full" });
      }
    }
    this.outbox.push({ frame, at: now });
  }

  /** Replay queued frames after hello_ok. Anything older than the TTL is
   *  reported as failed (never silently dropped, never double-sent). */
  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    const now = Date.now();
    const frames = this.outbox;
    this.outbox = [];
    for (const f of frames) {
      if (now - f.at > OUTBOX_TTL_MS) {
        const nonce = typeof f.frame.nonce === "string" ? f.frame.nonce : "";
        if (nonce && this.pendingAcks.has(nonce)) {
          this.pendingAcks.delete(nonce);
          this.opts.onCmdAck?.(nonce, false, { cmd: String(f.frame.cmd ?? ""), message: "not sent — connection was down too long" });
        }
        continue;
      }
      this.sendRaw(f.frame);
    }
  }

  /** Drop a queued/unacked command (e.g. before a manual retry sends a new one). */
  cancelPending(nonce: string): void {
    this.pendingAcks.delete(nonce);
    this.outbox = this.outbox.filter((f) => f.frame.nonce !== nonce);
  }

  /** Count of commands awaiting delivery or acknowledgement. */
  pendingCommandCount(): number {
    return this.pendingAcks.size + this.outbox.length;
  }

  openSession(opts: { id?: string; cwd?: string; seat?: string; approval?: string } = {}): void {
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

  /** Send one delivery-tracked command; returns its nonce (see onCmdAck). */
  private tracked(frame: Record<string, unknown>, cmdName: string): string {
    const nonce = newNonce();
    frame.nonce = nonce;
    this.pendingAcks.set(nonce, { cmd: cmdName, at: Date.now() });
    this.sendRaw(frame);
    return nonce;
  }

  prompt(sessionId: string, text: string): string {
    return this.tracked(cmd("prompt.submit", { session: sessionId, text }), "prompt.submit");
  }

  steer(sessionId: string, text: string): string {
    return this.tracked(cmd("steering.inject", { session: sessionId, text }), "steering.inject");
  }

  respond(sessionId: string, requestId: string, choice: "once" | "always" | "deny", note?: string): void {
    this.sendRaw(cmd("permission.respond", { session: sessionId, request_id: requestId, choice, note }));
  }

  /** Send only on the live socket; unlike ordinary commands this never enters
   * the reconnect outbox because a pack-form value is sensitive and tied to
   * one current core request. */
  private sendLive(frame: Record<string, unknown>): boolean {
    if (this.phase !== "live" || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Answer a pack form. Values are sent once and are never retained in the
   * reconnect outbox. False means the UI should keep the form editable. */
  uiRespond(sessionId: string, requestId: string, response: { status: "ok"; value?: unknown } | { status: "cancelled" }): boolean {
    return this.sendLive(cmd("ui.respond", { session: sessionId, request_id: requestId, ...response }));
  }

  interrupt(sessionId: string): void {
    this.sendRaw(cmd("interrupt", { session: sessionId }));
  }

  slash(sessionId: string, raw: string): string {
    return this.tracked(cmd("slash", { session: sessionId, raw }), "slash");
  }

  configureSession(
    id: string,
    patch: { provider?: string; model?: string; thinking_effort?: ThinkingEffort; cwd?: string },
  ): void {
    this.sendRaw(cmd("session.configure", { id, ...patch }));
  }

  renameSession(id: string, title: string): void {
    this.sendRaw(cmd("session.rename", { id, title }));
  }

  closeSession(id: string): void {
    this.sendRaw(cmd("session.close", { id }));
  }

  deleteSession(id: string): void {
    this.sendRaw(cmd("session.delete", { id }));
  }

  clearSession(id: string): void {
    this.sendRaw(cmd("session.clear", { id }));
  }

  deleteSessions(scope: DeleteScope): void {
    this.sendRaw(cmd("session.delete_all", { scope }));
  }

  // ---------- crew extension (host-prefixed until promoted) ----------

  crewOpen(run: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.open`, { run }));
  }

  crewClose(run: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.close`, { run }));
  }

  crewTail(run: string, worker: string, lines = 80): void {
    this.sendRaw(cmd(`${CREW_EXT}.tail`, { run, worker, lines }));
  }

  crewSubscribe(run: string, worker: string, subscription: string, cursor?: { generation: string; offset: number }, events_cursor?: { attempt: string; seq: number }): void {
    this.sendRaw(cmd(`${CREW_EXT}.subscribe`, { run, worker, subscription, ...(cursor ? { cursor } : {}), ...(events_cursor ? { events_cursor } : {}) }));
  }

  crewPermission(run: string, worker: string, attempt: string, id: string, choice: "once" | "always" | "deny"): void {
    this.sendRaw(cmd(`${CREW_EXT}.permission`, { run, worker, attempt, id, choice }));
  }

  crewUnsubscribe(run: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.unsubscribe`, { run }));
  }

  crewFile(run: string, path: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.file`, { run, path }));
  }

  crewStop(run: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.stop`, { run }));
  }

  crewResume(run: string, answer: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.resume`, { run, answer }));
  }

  /** Delete one finished run's record (manifest, worker dirs, logs). */
  crewRemove(run: string): void {
    this.sendRaw(cmd(`${CREW_EXT}.remove`, { run }));
  }

  /** Delete every finished run's record in one sweep. */
  crewClearFinished(): void {
    this.sendRaw(cmd(`${CREW_EXT}.clear`, {}));
  }

  // ---------- self-edit extension (host-prefixed until promoted) ----------

  uiStatus(): void {
    this.sendRaw(cmd(`${SELF_UI_EXT}.status`, {}));
  }

  uiBuild(opts: { check?: boolean; tests?: boolean } = {}): void {
    this.sendRaw(cmd(`${SELF_UI_EXT}.build`, { ...opts }));
  }

  uiRollback(): void {
    this.sendRaw(cmd(`${SELF_UI_EXT}.rollback`, {}));
  }

  hostRestart(reason = "", force = false): void {
    this.sendRaw(cmd(`${SELF_HOST_EXT}.restart`, { reason, force }));
  }

  hostRestartCancel(): void {
    this.sendRaw(cmd(`${SELF_HOST_EXT}.restart_cancel`, {}));
  }

  // ---------- pack credentials ----------

  /** Values are sent once and stored host-side (0600, DEXT_HOME); nothing
   *  comes back but names. `clear` removes stored names. */
  packCredentialsSet(name: string, values: Record<string, string>, clear: string[] = []): void {
    this.sendRaw(cmd(`${PACK_CREDENTIALS_EXT}.set`, { name, values, ...(clear.length ? { clear } : {}) }));
  }

  // ---------- flows (host-prefixed until promoted) ----------

  flowsList(cwd?: string): void {
    this.sendRaw(cmd(`${FLOWS_EXT}.list`, cwd ? { cwd } : {}));
  }

  flowsGet(name: string, cwd?: string): void {
    this.sendRaw(cmd(`${FLOWS_EXT}.get`, { name, ...(cwd ? { cwd } : {}) }));
  }

  flowsPut(flow: FlowFile, cwd?: string): void {
    this.sendRaw(cmd(`${FLOWS_EXT}.put`, { flow, ...(cwd ? { cwd } : {}) }));
  }

  flowsDelete(name: string, cwd?: string): void {
    this.sendRaw(cmd(`${FLOWS_EXT}.delete`, { name, ...(cwd ? { cwd } : {}) }));
  }

  flowsCompile(name: string, cwd?: string): void {
    this.sendRaw(cmd(`${FLOWS_EXT}.compile`, { name, ...(cwd ? { cwd } : {}) }));
  }

  flowsRun(name: string, cwd?: string, rev?: number): void {
    this.sendRaw(cmd(`${FLOWS_EXT}.run`, { name, ...(cwd ? { cwd } : {}), ...(typeof rev === "number" ? { rev } : {}) }));
  }

  // ---------- shared tasks (host-prefixed until promoted) ----------

  tasksList(cwd?: string): void {
    this.sendRaw(cmd(`${TASKS_EXT}.list`, cwd ? { cwd } : {}));
  }

  tasksGet(name: string, cwd?: string): void {
    this.sendRaw(cmd(`${TASKS_EXT}.get`, { name, ...(cwd ? { cwd } : {}) }));
  }

  /** `expectedRev`: optimistic concurrency — a mismatched rev is refused with
   *  `stale_rev` instead of silently clobbering a concurrent writer. */
  tasksPut(task: TaskRecord, opts: { cwd?: string; expectedRev?: number; actor?: "agent" | "user" } = {}): void {
    this.sendRaw(cmd(`${TASKS_EXT}.put`, {
      task,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.expectedRev !== undefined ? { expected_rev: opts.expectedRev } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
    }));
  }

  tasksDelete(name: string, cwd?: string): void {
    this.sendRaw(cmd(`${TASKS_EXT}.delete`, { name, ...(cwd ? { cwd } : {}) }));
  }

  // ---------- folder picker (host-prefixed until promoted) ----------

  dirsList(path?: string): void {
    this.sendRaw(cmd(`${DIRS_EXT}.list`, path ? { path } : {}));
  }

  dirsCreate(path: string, name: string): void {
    this.sendRaw(cmd(`${DIRS_EXT}.create`, { path, name }));
  }

  // ---------- connectors (host-prefixed until promoted) ----------

  connectorsList(): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.list`, {}));
  }

  /** `secret`: git token, or the token JSON printed by `rclone authorize`;
   *  `ticket`: from a completed `connectorsAuthorize` sign-in. Sent once; never echoed. */
  connectorsAdd(opts: { kind: ConnectorKind; label: string; remote: string; secret?: string; ticket?: string }): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.add`, opts));
  }

  /** Start an OAuth sign-in for a drive kind; the consent URL arrives as a `connectors.authorize` event. */
  connectorsAuthorize(kind: ConnectorKind): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.authorize`, { kind }));
  }

  /** Browser on another device: replay the loopback landing address through the host. */
  connectorsRelay(ticket: string, landing: string): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.relay`, { ticket, landing }));
  }

  connectorsCancelAuth(ticket?: string): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.cancel`, ticket ? { ticket } : {}));
  }

  connectorsRemove(id: string, purge = false): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.remove`, { id, purge }));
  }

  connectorsSync(id: string): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.sync`, { id }));
  }

  connectorsPush(id: string, message?: string): void {
    this.sendRaw(cmd(`${CONNECTORS_EXT}.push`, message ? { id, message } : { id }));
  }

  // ---------- provider sign-in (host-prefixed until promoted) ----------

  authStatus(): void {
    this.sendRaw(cmd(`${AUTH_EXT}.status`, {}));
  }

  authLogin(provider: string, credential: string): void {
    this.sendRaw(cmd(`${AUTH_EXT}.login`, { provider, credential }));
  }

  authLogout(provider: string): void {
    this.sendRaw(cmd(`${AUTH_EXT}.logout`, { provider }));
  }

  // ---------- pack file editing (host-prefixed until promoted) ----------

  packFiles(pack: string): void {
    this.sendRaw(cmd(`${PACK_EXT}.files`, { pack }));
  }

  packFile(pack: string, path: string): void {
    this.sendRaw(cmd(`${PACK_EXT}.file`, { pack, path }));
  }

  packWrite(pack: string, path: string, text: string): void {
    this.sendRaw(cmd(`${PACK_EXT}.write`, { pack, path, text }));
  }

  private forget(id: string): void {
    this.sessions.delete(id);
    this.subscribed.delete(id);
    this.resyncPending.delete(id);
    this.metadata.delete(id);
    this.removed.add(id);
    this.opts.onSessionRemoved?.(id);
  }

  private reset(id: string, generation: number, resubscribe: boolean): void {
    this.sessions.delete(id);
    this.resyncPending.delete(id);
    this.opts.onSessionCleared?.(id, generation);
    if (resubscribe && this.subscribed.has(id)) this.subscribe(id, true);
  }

  /** Lists are authoritative, including clears/deletes missed while offline. */
  private acceptList(list: SessionMeta[], resubscribe: boolean): void {
    const ids = new Set(list.map((m) => m.id));
    for (const id of new Set([...this.metadata.keys(), ...this.sessions.keys(), ...this.subscribed])) {
      if (!ids.has(id)) this.forget(id);
    }
    for (const meta of list) {
      const prev = this.metadata.get(meta.id);
      this.removed.delete(meta.id);
      this.metadata.set(meta.id, meta);
      if (prev && (prev.generation ?? 0) !== (meta.generation ?? 0)) {
        this.reset(meta.id, meta.generation ?? 0, resubscribe);
      }
    }
    this.opts.onSessionList?.(list);
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
      if (this.removed.has(sessionId)) return; // late tails cannot resurrect deleted stores
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
      this.opts.onEvent?.(env, store);
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
          packs?: PackInfo[];
          crews?: CrewsPayload;
          self?: SelfStatus;
          home?: string;
        };
        this.capabilities = d.capabilities;
        this.modelCatalog = d.model_catalog ?? [];
        this.effortOptions = d.effort_options ?? [];
        this.commands = d.commands ?? [];
        this.packs = d.packs ?? [];
        this.opts.onPacksChanged?.(this.packs);
        this.crews = d.crews ?? { runs: [], omitted: 0 };
        this.opts.onCrewsChanged?.(this.crews);
        this.self = d.self ?? null;
        if (this.self) this.opts.onSelfChanged?.(this.self);
        this.home = typeof d.home === "string" ? d.home : "";
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
        this.acceptList(d.sessions, false);
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
        // Replay anything typed while the socket was down, verbatim — the host
        // remembers nonces, so a reconnect replay can never double-run work.
        this.flushOutbox();
        if (this.capabilities.includes("provider_auth")) this.authStatus();
        break;
      }
      case "x-agentlinkd.auth.status": {
        const d = env.data as { model_catalog?: ModelGroup[] };
        if (Array.isArray(d?.model_catalog)) this.modelCatalog = d.model_catalog;
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
        this.acceptList(d.sessions, true);
        break;
      }
      case "session.removed": {
        const d = env.data as { id: string };
        this.forget(d.id);
        break;
      }
      case "session.cleared": {
        const d = env.data as { id: string; generation: number };
        const meta = this.metadata.get(d.id);
        if (meta) this.metadata.set(d.id, { ...meta, generation: d.generation });
        this.reset(d.id, d.generation, true);
        break;
      }
      case "packs.changed": {
        const d = env.data as { packs: PackInfo[]; commands?: HostCommand[] };
        this.packs = d.packs ?? [];
        if (d.commands) this.commands = d.commands;
        this.opts.onPacksChanged?.(this.packs);
        break;
      }
      case "pong":
        this.lastPongAt = Date.now();
        return;
      case `${CREW_EXT}.changed`: {
        const d = env.data as CrewsPayload | undefined;
        this.crews = { runs: d?.runs ?? [], omitted: d?.omitted ?? 0 };
        this.opts.onCrewsChanged?.(this.crews);
        break;
      }
      case `${SELF_UI_EXT}.status`: {
        const d = env.data as SelfStatus | undefined;
        if (d && typeof d.repo === "string") {
          this.self = d;
          this.opts.onSelfChanged?.(d);
        }
        break;
      }
      case "ui.response_pending": {
        const d = env.data as { session?: string; request_id?: string } | undefined;
        if (typeof d?.session === "string" && typeof d.request_id === "string") {
          const store = this.session(d.session);
          const failure: Envelope = { v: PROTOCOL_VERSION, session: d.session, ts: env.ts, event: "ui.response_failed", data: { id: d.request_id, message: "Another client is already sending an answer; retry if the form remains open" } };
          store.apply(failure);
          this.opts.onEvent?.(failure, store);
        }
        break;
      }
      case "ui.already_resolved": {
        const d = env.data as { session?: string; request_id?: string } | undefined;
        if (typeof d?.session === "string" && typeof d.request_id === "string") {
          const store = this.session(d.session);
          const resolved: Envelope = { v: PROTOCOL_VERSION, session: d.session, ts: env.ts, event: "ui.resolved", data: { id: d.request_id, status: "completed" } };
          store.apply(resolved);
          this.opts.onEvent?.(resolved, store);
        }
        break;
      }
      case "cmd_ack": {
        const d = env.data as { nonce?: string; ok?: boolean; duplicate?: boolean; durable?: boolean; message?: string } | undefined;
        const nonce = typeof d?.nonce === "string" ? d.nonce : "";
        const pending = nonce ? this.pendingAcks.get(nonce) : undefined;
        // Unknown nonce = already resolved or cancelled: report delivery once,
        // never twice (a replayed ack must not double-fire).
        if (!pending) break;
        this.pendingAcks.delete(nonce);
        this.opts.onCmdAck?.(nonce, d?.ok !== false, {
          cmd: pending?.cmd ?? "",
          duplicate: d?.duplicate === true,
          durable: d?.durable !== false,
          message: d?.message,
        });
        break;
      }
      case "error": {
        const d = env.data as { code: string; message: string; cmd?: string; data?: Record<string, unknown> };
        // A rejection answers exactly one in-flight command when unambiguous
        // (one pending send of that cmd kind) — resolve it as failed delivery.
        if (typeof d.cmd === "string" && d.cmd) {
          const hits = [...this.pendingAcks.entries()].filter(([, p]) => p.cmd === d.cmd);
          const hitNonce = hits.length === 1 ? hits[0]?.[0] : undefined;
          if (hitNonce !== undefined) {
            this.pendingAcks.delete(hitNonce);
            this.opts.onCmdAck?.(hitNonce, false, { cmd: d.cmd, message: d.message });
          }
        }
        this.opts.onControlError?.(d.code, d.message, d.data);
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
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      // Heartbeat deadline: a socket that stops answering pings is half-dead.
      // Closing it runs the normal reconnect path (backoff, outbox replay) —
      // silence must never read as health.
      if (Date.now() - this.lastPongAt > PONG_DEADLINE_MS) {
        try { this.ws?.close(); } catch { /* already closed */ }
        return;
      }
      this.sendRaw(cmd("ping"));
      // Safety net: sent-but-unacked nonces expire after the outbox TTL (the
      // app layer reports sooner). Frames still queued are flushOutbox's job.
      const now = Date.now();
      for (const [nonce, p] of [...this.pendingAcks]) {
        if (now - p.at <= OUTBOX_TTL_MS) continue;
        if (this.outbox.some((f) => f.frame.nonce === nonce)) continue;
        this.pendingAcks.delete(nonce);
        this.opts.onCmdAck?.(nonce, false, { cmd: p.cmd, message: "no acknowledgment from the host" });
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
