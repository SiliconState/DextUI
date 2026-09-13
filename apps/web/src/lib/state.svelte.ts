// App-level reactive state bridging the framework-free Connection into Svelte 5 runes.

import { Connection, type ConnPhase, type PendingPackUi, type PendingPermission } from "@dextui/client";
import type { Envelope, HostCommand, ModelGroup, PackInfo, SessionMeta, ThinkingEffort } from "@dextui/protocol";
import { notifyEvent } from "./notify";
import { acceptCrews, crewEscalations, onCrewControl, openRun } from "./crew.svelte";
import { onPackControl } from "./packsheet.svelte";
import { acceptSelf, onSelfControl, onSelfReconnected } from "./selfedit.svelte";
import { onDirsControl, onFolderEvent } from "./folders.svelte";
import { onPackCredsControl } from "./packcreds.svelte";
import { onConnectorsControl } from "./connectors.svelte";
import { onFlowsControl } from "./flows.svelte";
import { onTasksControl } from "./tasks.svelte";
import { clearAttachments } from "./uploads.svelte";
import { packTitle } from "./display";

export type Theme = "dark" | "dim" | "light" | "system";
export type NotifyState = "on" | "off" | "blocked";
export type SessionAction = { kind: "rename" | "clear" | "delete"; id: string } | { kind: "bulk"; scope: "all" | "cold" };

export interface Toast {
  id: number;
  kind: "info" | "ok" | "warn" | "err";
  text: string;
  /** Optional one-click follow-up (e.g. switch approval profile). */
  action?: { label: string; run: () => void };
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
  /** Compact routine structural tool activity; Bash and rich tools stay full. */
  compactTools: true,
  /** Raw envelope tail drawer for the active session. */
  eventsOpen: false,
  /** Settings popover (theme · work details · notifications · providers · sign out). */
  settingsOpen: false,
  /** Viewport rect of the trigger, so the popover anchors to it and opens
   *  away from the nearest edge; null → default bottom-right corner. */
  settingsAnchor: null as { top: number; bottom: number; right: number } | null,
  /** Session-controls popover (model · effort · approval): the session's
   *  runtime controls behind one status-bar chip. Mutually exclusive with the
   *  settings popover — one status-bar menu at a time. */
  sessionCtlOpen: false,
  sessionCtlAnchor: null as { top: number; bottom: number; right: number } | null,
  sidebarCollapsed: false,
  theme: "dark" as Theme,
  /** Resolved (never "system") — drives <html data-theme>. "dim" is a
   *  dark-family variant; artifact consumers collapse it to "dark". */
  resolvedTheme: "dark" as "dark" | "dim" | "light",
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
  /** Host pack catalog (hello_ok.packs, replaced on packs.changed). */
  packs: [] as PackInfo[],
  /** One-shot composer prefill; `n` changes on every request so the same text can be requested twice. */
  prefill: null as { text: string; n: number } | null,
  /** Gallery overlay (`g`); the gallery also renders inline in empty sessions and the hero. */
  galleryOpen: false,
});

let prefillSeq = 0;

/** Put text in the composer (creating a session first when none is active) and focus it. */
export function prefillComposer(text: string): void {
  if (!app.activeId) {
    app.pendingDraft = text;
    newSession();
    return;
  }
  app.prefill = { text, n: ++prefillSeq };
}

/** Gallery-visible packs: curated first, then every other pack the host lists. */
export function galleryPacks(): PackInfo[] {
  return app.packs.filter((p) => p.ui.gallery);
}

/** The text a card/row puts in the composer. Starter prompts that already
 *  begin with `/pack` are used verbatim; anything else becomes the pack's task. */
export function packStarter(p: PackInfo): string {
  const s = p.ui.starter_prompt;
  return s.trimStart().startsWith("/pack") ? s : `/pack run ${p.name} ${s.trim()}`;
}

const APPROVAL_RANK: Record<string, number> = { never: 0, ask: 0, "auto-read": 1, "auto-write": 2, always: 3 };

/** Approval profile of the active session, if any. */
export function activeApproval(): string | undefined {
  return app.sessions.find((s) => s.id === app.activeId)?.approval_profile;
}

/** Requirements `p` cannot meet right now. The host computed `unmet` against
 *  its default profile; approval requirements are re-evaluated here against
 *  `profile` (the active session) in both directions, so a session that is
 *  stricter than the default is not shown a green card the host will refuse. */
export function packUnmet(p: PackInfo, profile = activeApproval()): string[] {
  const other = p.unmet.filter((u) => !u.startsWith("approval:"));
  const approval = p.ui.requires.filter((u) => {
    if (!u.startsWith("approval:")) return false;
    if (!profile) return p.unmet.includes(u);
    return (APPROVAL_RANK[u.slice(9)] ?? 99) > (APPROVAL_RANK[profile] ?? 0);
  });
  return [...approval, ...other];
}

/** Pack a turn was run with, derived from its journaled prompt (`/pack run <name>`). */
export function packOfPrompt(text: string): string | null {
  const m = /^\/packs?\s+(?:run|use|start)\s+([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/.exec(text.trim());
  return m?.[1] ?? null;
}

// ---------- global action queue ----------
//
// Every pending human decision across ALL sessions of the current connection:
// full entries from subscribed stores, count-only rows from SessionMeta for
// sessions whose snapshot is still in flight (or hosts without the events).
// Rebuilt from permission/form events and session snapshots — never polled.

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
export interface UiQueueEntry {
  sessionId: string;
  sessionTitle: string;
  pending: PendingPackUi;
}

export const queue = $state({ entries: [] as QueueEntry[], uiEntries: [] as UiQueueEntry[], counts: [] as QueueCount[] });

/** Sessions subscribed to only because they had pending approvals. */
const autoSubscribed = new Set<string>();
/** Auto-subscribed sessions whose first post-subscribe envelope has not
 *  arrived yet. Until it does, the local store is empty (no pending, not
 *  working) and must not be mistaken for "went quiet" by the detach mirror. */
const hydrating = new Set<string>();

/** Decisions only: pending permissions plus open crew escalations. Run
 *  failures are observation and never count (title badge, rail badge). */
export function queueTotal(): number {
  return queue.entries.length + queue.uiEntries.length + queue.counts.reduce((n, s) => n + s.count, 0) + crewEscalations().length;
}

function rebuildQueue(): void {
  const c = app.conn;
  if (!c) {
    queue.entries = [];
    queue.uiEntries = [];
    queue.counts = [];
    return;
  }
  const titleOf = (id: string): string =>
    app.sessions.find((s) => s.id === id)?.title ?? c.session(id).state.title ?? id;
  const entries: QueueEntry[] = [];
  const uiEntries: UiQueueEntry[] = [];
  for (const id of c.subscribed) {
    const state = c.session(id).state;
    for (const p of state.pending.values()) {
      entries.push({ sessionId: id, sessionTitle: titleOf(id), pending: p });
    }
    if (state.pendingUi) uiEntries.push({ sessionId: id, sessionTitle: titleOf(id), pending: state.pendingUi });
  }
  // Oldest first within each decision kind; the rail renders forms before tool
  // approvals because forms block an active pack runtime without shortcuts.
  entries.sort((a, b) => a.pending.received_at - b.pending.received_at);
  uiEntries.sort((a, b) => a.pending.received_at - b.pending.received_at);
  const withEntries = new Set([...entries.map((e) => e.sessionId), ...uiEntries.map((e) => e.sessionId)]);
  queue.counts = app.sessions
    .map((s) => ({ id: s.id, title: s.title, count: s.pending_permissions + (s.pending_ui_requests ?? 0) }))
    .filter((s) => s.count > 0 && !withEntries.has(s.id));
  queue.entries = entries;
  queue.uiEntries = uiEntries;
  // Detach mirror: an auto-subscribed session that went quiet and is not the
  // active one drops off the live tail again (same policy as activate()).
  // Sessions still waiting for their snapshot/replay are left alone.
  for (const id of [...autoSubscribed]) {
    if (id === app.activeId || hydrating.has(id)) continue;
    const st = c.session(id).state;
    if (st.pending.size === 0 && !st.pendingUi && !st.working && !st.compacting) {
      c.unsubscribe(id);
      autoSubscribed.delete(id);
    }
  }
}

// ---------- delivery tracking (prompts / steering / slash) ----------
//
// Composer.send() records each send here (nonce -> text + session); the
// Connection reports the host's cmd_ack (or an error correlation). On failure
// the text is restored to the composer and a retry toast offers a fresh send —
// never an automatic resend, which could double-run a turn that landed.

interface Outgoing {
  sessionId: string;
  text: string;
  kind: "prompt" | "steer" | "slash";
  at: number;
}
const outgoing = new Map<string, Outgoing>();
const OUTGOING_TTL_MS = 20_000;

/** Register a just-sent command so its outcome can restore the text. */
export function trackDelivery(nonce: string, entry: Omit<Outgoing, "at">): void {
  if (!nonce) return;
  outgoing.set(nonce, { ...entry, at: Date.now() });
  setTimeout(() => expireDelivery(nonce), OUTGOING_TTL_MS);
}

function expireDelivery(nonce: string): void {
  const e = outgoing.get(nonce);
  if (!e) return; // already acknowledged
  outgoing.delete(nonce);
  failDelivery(nonce, e, "no acknowledgment from the host — check the transcript before resending");
}

function failDelivery(nonce: string, e: Outgoing, why: string): void {
  app.conn?.cancelPending(nonce);
  const draftKey = `dextui.draft.${e.sessionId}`;
  const stillThere = app.sessions.some((s) => s.id === e.sessionId);
  // Restore only into an empty draft: never clobber text typed since.
  const restore = stillThere && !localStorage.getItem(draftKey);
  if (restore) {
    localStorage.setItem(draftKey, e.text);
    app.draftRevisions[e.sessionId] = (app.draftRevisions[e.sessionId] ?? 0) + 1;
  }
  pushToast("err", `Not sent — ${why}${restore ? " (text restored to the composer)" : ""}`, {
    label: "Retry",
    run: () => resend(e),
  });
}

function resend(e: Outgoing): void {
  const c = app.conn;
  if (!c || app.phase !== "live") {
    pushToast("warn", "Not connected — try again once live");
    return;
  }
  const nonce =
    e.kind === "prompt" ? c.prompt(e.sessionId, e.text)
      : e.kind === "steer" ? c.steer(e.sessionId, e.text)
        : c.slash(e.sessionId, e.text);
  trackDelivery(nonce, { sessionId: e.sessionId, text: e.text, kind: e.kind });
}

let started = false;
let everLive = false;
let wantNewSession = false;
let newSessionBaseline = new Set<string>();
let toastSeq = 0;
let selectionAfterRemoval: number | null = null;
let expectedRename = "";
let sessionActionTimer: ReturnType<typeof setTimeout> | undefined;
const ACTIVE_SESSION_KEY = "dextui.activeSession";

/** Remember tab selection without coupling it to process lifecycle. Restoring a
 *  tab subscribes to its transcript only; it never wakes a cold agent. */
function rememberActiveSession(id: string): void {
  if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
  else localStorage.removeItem(ACTIVE_SESSION_KEY);
}

function purgeLocalSession(id: string): void {
  app.draftRevisions[id] = (app.draftRevisions[id] ?? 0) + 1;
  for (const prefix of ["draft", "history", "generation"]) localStorage.removeItem(`dextui.${prefix}.${id}`);
  autoSubscribed.delete(id);
  hydrating.delete(id);
  clearAttachments(id);
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

export function pushToast(kind: Toast["kind"], text: string, action?: Toast["action"]): void {
  const t: Toast = { id: ++toastSeq, kind, text, ...(action ? { action } : {}) };
  app.toasts.push(t);
  setTimeout(() => dismissToast(t.id), action ? 12000 : kind === "err" ? 8000 : 4000);
}

export function dismissToast(id: number): void {
  const i = app.toasts.findIndex((t) => t.id === id);
  if (i >= 0) app.toasts.splice(i, 1);
}

const sysDark = matchMedia("(prefers-color-scheme: dark)");

function resolveTheme(t: Theme): "dark" | "dim" | "light" {
  if (t === "system") return sysDark.matches ? "dark" : "light";
  return t;
}

function applyTheme(t: Theme): void {
  const resolved = resolveTheme(t);
  app.resolvedTheme = resolved;
  document.documentElement.dataset.theme = resolved;
  // Keep installed-PWA/browser chrome in sync with the resolved scheme.
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    resolved === "light" ? "#f4f2ec" : resolved === "dim" ? "#1b1f27" : "#0b0d10",
  );
}

/** dark → dim → light → system → dark */
export function toggleTheme(): void {
  app.theme = app.theme === "dark" ? "dim" : app.theme === "dim" ? "light" : app.theme === "light" ? "system" : "dark";
  localStorage.setItem("dextui.theme", app.theme);
  applyTheme(app.theme);
}

/** Pick a theme directly (settings popover); persisted like the cycle. */
export function setTheme(t: Theme): void {
  app.theme = t;
  localStorage.setItem("dextui.theme", t);
  applyTheme(t);
}

export function setCompactTools(compact: boolean): void {
  app.compactTools = compact;
  localStorage.setItem("dextui.compactTools", compact ? "1" : "0");
}

/** Open the settings popover, anchored to the trigger's viewport rect so it
 *  opens away from the nearest edge; pass nothing to fall back to the corner. */
export function openSettings(anchor?: { top: number; bottom: number; right: number }): void {
  app.sessionCtlOpen = false;
  app.sessionCtlAnchor = null;
  app.settingsAnchor = anchor ?? null;
  app.settingsOpen = true;
}

export function closeSettings(): void {
  app.settingsOpen = false;
  app.settingsAnchor = null;
}

/** Open the session-controls popover (model · effort · approval), anchored to
 *  the chip's viewport rect so it opens away from the nearest edge; pass
 *  nothing to fall back to the corner (Finder entry). */
export function openSessionCtl(anchor?: { top: number; bottom: number; right: number }): void {
  app.settingsOpen = false;
  app.settingsAnchor = null;
  app.sessionCtlAnchor = anchor ?? null;
  app.sessionCtlOpen = true;
}

export function closeSessionCtl(): void {
  app.sessionCtlOpen = false;
  app.sessionCtlAnchor = null;
}

/** Preserve the exact resolved palette for interactive reports. */
export function currentResolvedTheme(): "dark" | "dim" | "light" {
  return app.resolvedTheme;
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
  const theme: Theme = stored === "dark" || stored === "dim" || stored === "light" || stored === "system" ? stored : "system";
  app.theme = theme;
  app.sidebarCollapsed = localStorage.getItem("dextui.sidebarCollapsed") === "1";
  app.compactTools = localStorage.getItem("dextui.compactTools") !== "0";
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
  queue.uiEntries = [];
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
        queue.uiEntries = [];
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
        // Connected folders drive the picker's Connected section and the
        // status line's sync affordance: fetch once per (re)connect.
        if (c.capabilities.includes("connectors")) c.connectorsList();
        if (everLive) pushToast("ok", "Reconnected");
        everLive = true;
        // The Connection re-attaches every subscribed tail itself (seq-resume on
        // the same host instance, fresh snapshot after a host restart).
      }
    },
    onCmdAck: (nonce, ok, info) => {
      if (app.conn !== c) return;
      const e = outgoing.get(nonce);
      if (!e) return; // unknown nonce: already resolved (e.g. error correlation won)
      outgoing.delete(nonce);
      if (!ok) failDelivery(nonce, e, info.message || "the host rejected it");
      else if (info.durable === false) pushToast("warn", "Delivered, but not saved — the host's journal write failed; it may not survive a restart");
      else if (info.duplicate) pushToast("info", "Already delivered — reconnect replay skipped");
    },
    onHostRestart: () => {
      if (app.conn !== c) return;
      // Stores were dropped; force every `c.session(id)` lookup to re-resolve.
      app.hostEpoch++;
      queue.entries = [];
      queue.uiEntries = [];
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
      if (localStorage.getItem(ACTIVE_SESSION_KEY) === id) rememberActiveSession("");
      if (app.activeId === id) {
        selectionAfterRemoval = Math.max(0, app.sessions.findIndex((s) => s.id === id));
        app.activeId = "";
        rememberActiveSession("");
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
      app.sessions = app.sessions.map((s) => s.id === id ? { ...s, generation, pending_permissions: 0, pending_ui_requests: 0, last_seq: 0, model_locked: false } : s);
      app.hostEpoch++;
      if (app.sessionAction && "id" in app.sessionAction && app.sessionAction.id === id) finishSessionAction();
      rebuildQueue();
    },
    onSessionList: (sessions) => {
      if (app.conn !== c) return; // stale connection
      const ids = new Set(sessions.map((s) => s.id));
      const remembered = localStorage.getItem(ACTIVE_SESSION_KEY);
      if (remembered && !ids.has(remembered)) rememberActiveSession("");
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
          rememberActiveSession(neighbor.id);
          c.subscribe(neighbor.id);
        }
      }
      // Host restart: an active id can disappear while the Connection's local
      // stores survive. Drop the stale selection; a reused id will be reset by
      // the next snapshot rather than displaying the old host's transcript.
      if (app.activeId && !ids.has(app.activeId)) {
        app.activeId = "";
        rememberActiveSession("");
      }
      if (wantNewSession) {
        const fresh = sessions.find((s) => !newSessionBaseline.has(s.id));
        if (fresh) {
          wantNewSession = false;
          newSessionBaseline.clear();
          activate(fresh.id);
        }
      }
      if (!app.activeId && sessions.length > 0) {
        // Restore the exact tab selected before a page refresh. Subscribe only:
        // merely reloading the UI must never wake a cold agent process.
        const rememberedNow = localStorage.getItem(ACTIVE_SESSION_KEY);
        const prior = rememberedNow ? sessions.find((s) => s.id === rememberedNow) : undefined;
        if (prior) {
          app.activeId = prior.id;
          c.subscribe(prior.id);
        } else {
          // With no valid preference, auto-activate a live session only: waking
          // a cold one would spawn an agent process the user never asked for.
          const firstLive = sessions.find((s) => s.status === "live");
          if (firstLive) activate(firstLive.id);
        }
      }
      // A session with pending approvals is live by definition; subscribe so
      // it yields real cards and a real received_at instead of a bare count.
      // Subscribe only — never openSession/activate: spawning agents is not
      // our call.
      for (const s of sessions) {
        if ((s.pending_permissions > 0 || (s.pending_ui_requests ?? 0) > 0) && !c.subscribed.has(s.id)) {
          autoSubscribed.add(s.id);
          hydrating.add(s.id);
          c.subscribe(s.id);
        }
      }
      rebuildQueue();
    },
    onPacksChanged: (packs) => {
      if (app.conn !== c) return;
      const before = new Set(app.packs.map((p) => p.name));
      // Wire boundary: copy defensively so a host that omits an array cannot
      // throw inside a template, and so Svelte owns the reactive objects.
      app.packs = packs
        .filter((p) => p && typeof p.name === "string")
        .map((p) => ({
          ...p,
          description: p.description ?? "",
          ui: {
            starter_prompt: p.ui?.starter_prompt ?? `/pack run ${p.name} `,
            artifact: p.ui?.artifact ?? "markdown",
            time_to_first_artifact: p.ui?.time_to_first_artifact ?? 0,
            requires: [...(p.ui?.requires ?? [])],
            gallery: !!p.ui?.gallery,
            tags: [...(p.ui?.tags ?? [])],
            personas: [...(p.ui?.personas ?? [])],
            ...(p.ui?.icon ? { icon: p.ui.icon } : {}),
            ...(p.ui?.title ? { title: p.ui.title } : {}),
            ...(p.ui?.panel ? { panel: p.ui.panel } : {}),
            ...(Array.isArray(p.ui?.actions) && p.ui.actions.length
              ? { actions: p.ui.actions.filter((a) => a && typeof a.label === "string" && typeof a.prompt === "string").map((a) => ({ label: a.label, prompt: a.prompt })) }
              : {}),
          },
          unmet: [...(p.unmet ?? [])],
        }));
      app.commands = c.commands.map((x) => ({ ...x }));
      // A pack that just appeared (hero flow / `/pack create`) gets a run offer.
      if (before.size > 0) {
        for (const p of app.packs) {
          if (!before.has(p.name)) pushToast("ok", `New pack: ${packTitle(p)}`, { label: "run it", run: () => prefillComposer(`/pack run ${p.name} `) });
        }
      }
    },
    onCrewsChanged: (crews) => {
      if (app.conn !== c) return;
      acceptCrews(crews);
    },
    onSelfChanged: (self) => {
      if (app.conn !== c) return;
      acceptSelf(self);
      onSelfReconnected();
    },
    onControlError: (code, message, data) => {
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
      if (code === "pack_requires_profile" && typeof data?.required === "string") {
        const required = data.required;
        const sid = typeof data.session === "string" ? data.session : app.activeId;
        const pack = typeof data.pack === "string" ? data.pack : "pack";
        const retry = typeof data.retry === "string" ? data.retry : "";
        pushToast("warn", `${pack} needs approval profile ${required}`, {
          label: `Switch to ${required}`,
          run: () => {
            if (!sid || app.conn !== c) return;
            c.slash(sid, `/approval ${required}`);
            // The composer already cleared the command on send; hand it back
            // so the user only has to press Enter once the switch lands.
            if (retry && sid === app.activeId) prefillComposer(retry);
          },
        });
        return;
      }
      // Host could not resolve a pack name but has near names: offer the best
      // one as a prefilled command, so a typo costs one click, not a retype.
      if (code === "no_pack" && typeof data?.retry === "string" && Array.isArray(data.candidates) && data.candidates.length > 0) {
        const sid = typeof data.session === "string" ? data.session : app.activeId;
        const retry: string = data.retry;
        const first = String(data.candidates[0]);
        pushToast("warn", message, {
          label: `Use ${first}`,
          run: () => {
            if (app.conn !== c || (sid && sid !== app.activeId)) return;
            prefillComposer(retry);
          },
        });
        return;
      }
      pushToast("err", `${code}: ${message}`);
    },
    onEvent: (env: Envelope, store) => {
      if (app.conn !== c) return; // stale connection
      hydrating.delete(store.state.id); // the tail is real from here on
      onFolderEvent(env);
      switch (env.event) {
        case "permission.request":
        case "permission.resolved":
        case "permission.timeout":
        case "ui.request":
        case "ui.resolved":
        case "ui.response_failed":
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
    onCrewControl(env);
    onPackControl(env);
    onSelfControl(env);
    onDirsControl(env);
    onPackCredsControl(env);
    onConnectorsControl(env);
    onFlowsControl(env);
    onTasksControl(env);
    if (env.event === "ui.response_pending") {
      const d = env.data as { session?: string; request_id?: string } | undefined;
      if (d?.session === app.activeId) pushToast("info", "Another client is already sending an answer for this form");
    }
    if (env.event === "ui.already_resolved") {
      const d = env.data as { session?: string; request_id?: string } | undefined;
      if (d?.session === app.activeId) pushToast("info", "This form was already answered");
    }
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
  rememberActiveSession(id);
  autoSubscribed.delete(id); // user-driven from here on
  hydrating.delete(id);
  if (!c) return;
  if (prev && prev !== id && c.subscribed.has(prev)) {
    const ps = c.session(prev).state;
    if (!ps.working && !ps.compacting && ps.pending.size === 0 && !ps.pendingUi) c.unsubscribe(prev);
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
 * known pending form or approval (a count-only session when nothing fuller
 * exists), else the run sheet of the first crew escalation. */
export function jumpToOldestPending(): void {
  const form = queue.uiEntries[0];
  const permission = queue.entries[0];
  const oldest = !form ? permission : !permission ? form
    : form.pending.received_at <= permission.pending.received_at ? form : permission;
  if (oldest) {
    activate(oldest.sessionId);
    return;
  }
  const count = queue.counts[0];
  if (count) {
    activate(count.id);
    return;
  }
  const esc = crewEscalations()[0];
  if (esc) openRun(esc.id);
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
