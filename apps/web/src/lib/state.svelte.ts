// App-level reactive state bridging the framework-free Connection into Svelte 5 runes.

import { Connection, type ConnPhase, type PendingPermission } from "@dextui/client";
import type { Envelope, HostCommand, ModelGroup, SessionMeta, ThinkingEffort } from "@dextui/protocol";
import { notifyEvent } from "./notify";

export type Theme = "dark" | "light" | "system";
export type NotifyState = "on" | "off" | "blocked";
export type SessionAction = { kind: "rename" | "clear" | "delete"; id: string } | { kind: "bulk"; scope: "all" | "cold" };

export interface Toast {
  id: number;
  kind: "info" | "ok" | "warn" | "err";
  text: string;
}

export const app = $state({
  phase: "connecting" as ConnPhase,
  phaseDetail: "",
  sessions: [] as SessionMeta[],
  activeId: "",
  needsToken: false,
  lastError: "",
  conn: null as Connection | null,
  caps: [] as string[],
  modelCatalog: [] as ModelGroup[],
  effortOptions: [] as ThinkingEffort[],
  commands: [] as HostCommand[],
  /** Bumps whenever the host process identity changes (stores were reset). */
  hostEpoch: 0,
  paletteOpen: false,
  /** Raw envelope tail drawer for the active session. */
  eventsOpen: false,
  sidebarCollapsed: false,
  theme: "dark" as Theme,
  toasts: [] as Toast[],
  /** Desktop notifications. "blocked" is derived from the browser permission
   *  state, never persisted. */
  notify: "off" as NotifyState,
  /** Hero-typing stash: the printable key that spawned a fresh session. */
  pendingDraft: "",
  shortcutsOpen: false,
  sessionAction: null as SessionAction | null,
  sessionPending: false,
  draftRevisions: {} as Record<string, number>,
});

// ---------- global action queue ----------
//
// Every pending permission across ALL sessions of the current connection:
// full entries from subscribed stores, count-only rows from SessionMeta for
// sessions whose snapshot is still in flight (or hosts without the events).
// Rebuilt from the onEvent tap (permission.request/resolved/timeout,
// session.snapshot) and onSessionList — never polled.

export interface QueueEntry {
  sessionId: string;
  sessionTitle: string;
  pending: PendingPermission;
}
export interface QueueCount {
  id: string;
  title: string;
  count: number;
}

export const queue = $state({ entries: [] as QueueEntry[], counts: [] as QueueCount[] });

/** Sessions subscribed to only because they had pending approvals. */
const autoSubscribed = new Set<string>();
/** Auto-subscribed sessions whose first post-subscribe envelope has not
 *  arrived yet. Until it does, the local store is empty (no pending, not
 *  working) and must not be mistaken for "went quiet" by the detach mirror. */
const hydrating = new Set<string>();

export function queueTotal(): number {
  return queue.entries.length + queue.counts.reduce((n, s) => n + s.count, 0);
}

function rebuildQueue(): void {
  const c = app.conn;
  if (!c) {
    queue.entries = [];
    queue.counts = [];
    return;
  }
  const titleOf = (id: string): string =>
    app.sessions.find((s) => s.id === id)?.title ?? c.session(id).state.title ?? id;
  const entries: QueueEntry[] = [];
  for (const id of c.subscribed) {
    for (const p of c.session(id).state.pending.values()) {
      entries.push({ sessionId: id, sessionTitle: titleOf(id), pending: p });
    }
  }
  // Oldest first — the same order the global a/s/d keys act on. Count-only
  // rows cannot be ordered honestly and always sort after real entries.
  entries.sort((a, b) => a.pending.received_at - b.pending.received_at);
  const withEntries = new Set(entries.map((e) => e.sessionId));
  queue.counts = app.sessions
    .filter((s) => s.pending_permissions > 0 && !withEntries.has(s.id))
    .map((s) => ({ id: s.id, title: s.title, count: s.pending_permissions }));
  queue.entries = entries;
  // Detach mirror: an auto-subscribed session that went quiet and is not the
  // active one drops off the live tail again (same policy as activate()).
  // Sessions still waiting for their snapshot/replay are left alone.
  for (const id of [...autoSubscribed]) {
    if (id === app.activeId || hydrating.has(id)) continue;
    const st = c.session(id).state;
    if (st.pending.size === 0 && !st.working) {
      c.unsubscribe(id);
      autoSubscribed.delete(id);
    }
  }
}

let started = false;
let everLive = false;
let wantNewSession = false;
let newSessionBaseline = new Set<string>();
let toastSeq = 0;
let selectionAfterRemoval: number | null = null;
let expectedRename = "";
let sessionActionTimer: ReturnType<typeof setTimeout> | undefined;

function purgeLocalSession(id: string): void {
  app.draftRevisions[id] = (app.draftRevisions[id] ?? 0) + 1;
  for (const prefix of ["draft", "history", "generation"]) localStorage.removeItem(`dextui.${prefix}.${id}`);
  autoSubscribed.delete(id);
  hydrating.delete(id);
  if (app.activeId === id) {
    app.pendingDraft = "";
    app.eventsOpen = false;
  }
}

function finishSessionAction(): void {
  clearTimeout(sessionActionTimer);
  app.sessionPending = false;
  app.sessionAction = null;
}

export function requestSessionAction(action: SessionAction): void {
  if (app.phase !== "live" || app.sessionPending) return;
  if (!app.caps.includes("session_manage")) {
    // Keyboard paths (F2, Ctrl+Backspace, finder) must not fail silently.
    pushToast("warn", "This host doesn't advertise session_manage — restart it on current code to rename/clear/delete");
    return;
  }
  app.sessionAction = action;
  app.sidebarCollapsed = false;
}

export function confirmSessionAction(title = ""): void {
  const a = app.sessionAction;
  const c = app.conn;
  if (!a || !c || app.phase !== "live" || app.sessionPending) return;
  if (a.kind === "rename" && !title.trim()) return;
  app.sessionPending = true;
  sessionActionTimer = setTimeout(() => {
    app.sessionPending = false;
    pushToast("warn", "No session-operation acknowledgment yet; reconnect or retry if needed");
  }, 15000);
  if (a.kind === "bulk") c.deleteSessions(a.scope);
  else if (a.kind === "delete") c.deleteSession(a.id);
  else if (a.kind === "clear") c.clearSession(a.id);
  else {
    expectedRename = title.trim().slice(0, 80);
    c.renameSession(a.id, expectedRename);
  }
}

export function closeSession(id: string): void {
  if (app.phase === "live") app.conn?.closeSession(id);
}

export function wakeSession(id: string): void {
  if (app.phase === "live") app.conn?.openSession({ id });
}

export function connection(): Connection | null {
  return app.conn;
}

export function pushToast(kind: Toast["kind"], text: string): void {
  const t = { id: ++toastSeq, kind, text };
  app.toasts.push(t);
  setTimeout(() => dismissToast(t.id), kind === "err" ? 8000 : 4000);
}

export function dismissToast(id: number): void {
  const i = app.toasts.findIndex((t) => t.id === id);
  if (i >= 0) app.toasts.splice(i, 1);
}

const sysDark = matchMedia("(prefers-color-scheme: dark)");

function resolveTheme(t: Theme): "dark" | "light" {
  if (t === "system") return sysDark.matches ? "dark" : "light";
  return t;
}

function applyTheme(t: Theme): void {
  const resolved = resolveTheme(t);
  document.documentElement.dataset.theme = resolved;
  // Keep installed-PWA/browser chrome in sync with the resolved scheme.
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    resolved === "dark" ? "#0b0d10" : "#f4f2ec",
  );
}

/** dark → light → system → dark */
export function toggleTheme(): void {
  app.theme = app.theme === "dark" ? "light" : app.theme === "light" ? "system" : "dark";
  localStorage.setItem("dextui.theme", app.theme);
  applyTheme(app.theme);
}

export async function copyText(text: string, what = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    pushToast("ok", `${what}: ${text.length > 48 ? `${text.slice(0, 45)}…` : text}`);
  } catch {
    pushToast("err", "Clipboard unavailable");
  }
}

export function toggleSidebar(): void {
  app.sidebarCollapsed = !app.sidebarCollapsed;
  localStorage.setItem("dextui.sidebarCollapsed", app.sidebarCollapsed ? "1" : "0");
}

export function rePair(): void {
  localStorage.removeItem("dextui.token");
  location.reload();
}

export function ensureStarted(): void {
  if (started) return;
  started = true;
  const stored = localStorage.getItem("dextui.theme");
  const theme: Theme = stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
  app.theme = theme;
  app.sidebarCollapsed = localStorage.getItem("dextui.sidebarCollapsed") === "1";
  const storedNotify = localStorage.getItem("dextui.notify");
  app.notify =
    storedNotify === "1"
      ? typeof Notification === "undefined" || Notification.permission !== "granted"
        ? "blocked"
        : "on"
      : "off";
  applyTheme(theme);
  // Follow OS scheme changes live while in system mode.
  sysDark.addEventListener("change", () => {
    if (app.theme === "system") applyTheme("system");
  });
  const token = localStorage.getItem("dextui.token");
  if (token) start(token);
  else app.needsToken = true;
}

export function start(token: string): void {
  app.needsToken = false;
  app.lastError = "";
  // Retire any previous connection; its late callbacks must not clobber the new one.
  app.conn?.close();
  queue.entries = [];
  queue.counts = [];
  autoSubscribed.clear();
  hydrating.clear();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const c = new Connection({
    url: `${proto}://${location.host}/ws`,
    token,
    client: "dextui-web",
    onPhase: (p, detail) => {
      if (app.conn !== c) return; // stale connection
      const wasLive = app.phase === "live";
      app.phase = p;
      app.phaseDetail = detail ?? "";
      if (p === "failed") {
        app.caps = [];
        app.modelCatalog = [];
        app.effortOptions = [];
        app.commands = [];
        queue.entries = [];
        queue.counts = [];
        autoSubscribed.clear();
        hydrating.clear();
        app.lastError = detail ?? "authentication failed";
        pushToast("err", `Connection failed: ${app.lastError}`);
        app.needsToken = true;
        // A lockout says nothing about the token; keep it so a reload retries
        // without re-pairing. Only an actual rejection clears it.
        if (detail !== "rate_limited") localStorage.removeItem("dextui.token");
      }
      if (p === "reconnecting") {
        if (wantNewSession) {
          wantNewSession = false;
          newSessionBaseline.clear();
          app.pendingDraft = "";
        }
        // Both the socket close and every retry publish "reconnecting"; toast
        // once per outage, on the way down from live.
        if (wasLive) pushToast("warn", "Connection lost — reconnecting…");
      }
      if (p === "live") {
        // Snapshot capabilities into reactive state: conn.capabilities is a
        // plain mutated array, so deriveds can't track it directly.
        app.caps = [...c.capabilities];
        app.modelCatalog = c.modelCatalog.map((g) => ({ ...g, models: [...g.models] }));
        app.effortOptions = [...c.effortOptions];
        app.commands = c.commands.map((x) => ({ ...x }));
        if (everLive) pushToast("ok", "Reconnected");
        everLive = true;
        // The Connection re-attaches every subscribed tail itself (seq-resume on
        // the same host instance, fresh snapshot after a host restart).
      }
    },
    onHostRestart: () => {
      if (app.conn !== c) return;
      // Stores were dropped; force every `c.session(id)` lookup to re-resolve.
      app.hostEpoch++;
      queue.entries = [];
      queue.counts = [];
      autoSubscribed.clear();
      hydrating.clear();
      pushToast("warn", "Agent host restarted — transcripts resynced");
    },
    onSeqGap: (sessionId, expected, got) => {
      if (app.conn !== c) return;
      pushToast("warn", `Resyncing ${sessionId} (seq ${expected}→${got})`);
    },
    onSessionRemoved: (id) => {
      if (app.conn !== c) return;
      purgeLocalSession(id);
      if (app.activeId === id) {
        selectionAfterRemoval = Math.max(0, app.sessions.findIndex((s) => s.id === id));
        app.activeId = "";
      }
      app.sessions = app.sessions.filter((s) => s.id !== id);
      app.hostEpoch++;
      if (app.sessionAction && "id" in app.sessionAction && app.sessionAction.id === id) finishSessionAction();
      rebuildQueue();
    },
    onSessionCleared: (id, generation) => {
      if (app.conn !== c) return;
      purgeLocalSession(id);
      localStorage.setItem(`dextui.generation.${id}`, String(generation));
      app.sessions = app.sessions.map((s) => s.id === id ? { ...s, generation, pending_permissions: 0, last_seq: 0, model_locked: false } : s);
      app.hostEpoch++;
      if (app.sessionAction && "id" in app.sessionAction && app.sessionAction.id === id) finishSessionAction();
      rebuildQueue();
    },
    onSessionList: (sessions) => {
      if (app.conn !== c) return; // stale connection
      const ids = new Set(sessions.map((s) => s.id));
      // Also clean tabs opened after deletion, not just currently subscribed stores.
      for (const key of Object.keys(localStorage)) {
        const match = /^dextui\.(?:draft|history|generation)\.(.+)$/.exec(key);
        if (match?.[1] && !ids.has(match[1])) purgeLocalSession(match[1]);
      }
      for (const s of sessions) {
        const key = `dextui.generation.${s.id}`;
        const previous = Number(localStorage.getItem(key) ?? 0);
        if (previous !== (s.generation ?? 0)) purgeLocalSession(s.id);
        localStorage.setItem(key, String(s.generation ?? 0));
      }
      app.sessions = sessions;
      const rename = app.sessionAction;
      if (app.sessionPending && rename?.kind === "rename" && sessions.some((s) => s.id === rename.id && s.title === expectedRename)) finishSessionAction();
      if (selectionAfterRemoval !== null) {
        const neighbor = sessions[Math.min(selectionAfterRemoval, sessions.length - 1)];
        selectionAfterRemoval = null;
        if (neighbor) {
          // Show a neighbor without automatically waking a closed agent.
          app.activeId = neighbor.id;
          c.subscribe(neighbor.id);
        }
      }
      // Host restart: an active id can disappear while the Connection's local
      // stores survive. Drop the stale selection; a reused id will be reset by
      // the next snapshot rather than displaying the old host's transcript.
      if (app.activeId && !ids.has(app.activeId)) app.activeId = "";
      if (wantNewSession) {
        const fresh = sessions.find((s) => !newSessionBaseline.has(s.id));
        if (fresh) {
          wantNewSession = false;
          newSessionBaseline.clear();
          activate(fresh.id);
        }
      }
      if (!app.activeId && sessions.length > 0) {
        // Auto-activate a live session only: waking a cold one would spawn an
        // agent process the user never asked for. Cold sessions open on click.
        const firstLive = sessions.find((s) => s.status === "live");
        if (firstLive) activate(firstLive.id);
      }
      // A session with pending approvals is live by definition; subscribe so
      // it yields real cards and a real received_at instead of a bare count.
      // Subscribe only — never openSession/activate: spawning agents is not
      // our call.
      for (const s of sessions) {
        if (s.pending_permissions > 0 && !c.subscribed.has(s.id)) {
          autoSubscribed.add(s.id);
          hydrating.add(s.id);
          c.subscribe(s.id);
        }
      }
      rebuildQueue();
    },
    onControlError: (code, message) => {
      if (app.conn !== c) return; // stale connection
      // A failed session.open must not leave the new-session latch armed, nor
      // the hero-typing seed waiting to land in an unrelated session.
      if (wantNewSession) {
        wantNewSession = false;
        newSessionBaseline.clear();
        app.pendingDraft = "";
      }
      clearTimeout(sessionActionTimer);
      app.sessionPending = false;
      app.lastError = `${code}: ${message}`;
      pushToast("err", `${code}: ${message}`);
    },
    onEvent: (env: Envelope, store) => {
      if (app.conn !== c) return; // stale connection
      hydrating.delete(store.state.id); // the tail is real from here on
      switch (env.event) {
        case "permission.request":
        case "permission.resolved":
        case "permission.timeout":
        case "session.snapshot":
          rebuildQueue();
          break;
        default:
          break;
      }
      notifyEvent(env, store);
    },
  });
  c.onControl((env) => {
    if (app.conn !== c) return;
    if (env.event === "sessions.deleted") {
      const d = env.data as { ids: string[] };
      finishSessionAction();
      pushToast("ok", `Deleted ${d.ids.length} session(s)`);
    }
  });
  app.conn = c;
  c.connect();
  localStorage.setItem("dextui.token", token);
}

/** Make `id` the active session: wake it if cold, attach (resuming by seq when
 *  the local store already holds this host's history), and detach the previous
 *  session unless it still needs a live tail (working or awaiting approval). */
export function activate(id: string): void {
  const c = app.conn;
  const prev = app.activeId;
  app.activeId = id;
  autoSubscribed.delete(id); // user-driven from here on
  hydrating.delete(id);
  if (!c) return;
  if (prev && prev !== id && c.subscribed.has(prev)) {
    const ps = c.session(prev).state;
    if (!ps.working && ps.pending.size === 0) c.unsubscribe(prev);
  }
  const meta = app.sessions.find((s) => s.id === id);
  if (meta && meta.status === "cold") c.openSession({ id });
  c.subscribe(id);
}

export function newSession(): void {
  const c = app.conn;
  if (!c || app.phase !== "live" || wantNewSession) return;
  wantNewSession = true;
  newSessionBaseline = new Set(app.sessions.map((s) => s.id));
  c.openSession();
}

/** Respond to a pending approval in place — any session, no switch. */
export function respondGlobal(
  sessionId: string,
  requestId: string,
  choice: "once" | "always" | "deny",
): void {
  const c = app.conn;
  if (!c) return;
  const entry = queue.entries.find(
    (e) => e.sessionId === sessionId && e.pending.request_id === requestId,
  );
  c.respond(sessionId, requestId, choice);
  if (entry && sessionId !== app.activeId) {
    pushToast(
      choice === "deny" ? "warn" : "ok",
      `${choice === "deny" ? "⚠" : "✓"} ${entry.pending.tool} → ${choice} · “${entry.sessionTitle}”`,
    );
  }
}

/** Badge / notification-click target: open the session holding the oldest
 *  pending approval (a count-only session when nothing fuller exists). */
export function jumpToOldestPending(): void {
  const first = queue.entries[0];
  if (first) {
    activate(first.sessionId);
    return;
  }
  const count = queue.counts[0];
  if (count) activate(count.id);
}

/** Cycle the active session within index order (Ctrl+[ / Ctrl+]). */
export function stepSession(delta: number): void {
  const list = app.sessions;
  if (list.length === 0) return;
  const i = list.findIndex((s) => s.id === app.activeId);
  const next = list[i < 0 ? 0 : (i + delta + list.length) % list.length];
  if (next) activate(next.id);
}

/** Opt-in desktop notifications; enabling requests the browser permission. */
export async function toggleNotify(): Promise<void> {
  if (typeof Notification === "undefined") {
    app.notify = "blocked";
    pushToast("err", "Notifications unsupported");
    return;
  }
  if (app.notify === "on") {
    app.notify = "off";
    localStorage.setItem("dextui.notify", "0");
    return;
  }
  let perm: NotificationPermission = Notification.permission;
  if (perm !== "granted") {
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = "denied";
    }
  }
  if (perm === "granted") {
    app.notify = "on";
    localStorage.setItem("dextui.notify", "1");
    pushToast("ok", "Notifications on");
  } else {
    app.notify = "blocked";
    pushToast("err", "Notifications blocked — enable them in browser settings");
  }
}
