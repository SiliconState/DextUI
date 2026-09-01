// App-level reactive state bridging the framework-free Connection into Svelte 5 runes.

import { Connection, type ConnPhase } from "@dextui/client";
import type { SessionMeta } from "@dextui/protocol";

export type Theme = "dark" | "light" | "system";
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
  paletteOpen: false,
  theme: "dark" as Theme,
  toasts: [] as Toast[],
});

let started = false;
let everLive = false;
let reconcileAfterReconnect = false;
let wantNewSession = false;
let newSessionBaseline = new Set<string>();
let toastSeq = 0;

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
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const c = new Connection({
    url: `${proto}://${location.host}/ws`,
    token,
    client: "dextui-web",
    onPhase: (p, detail) => {
      if (app.conn !== c) return; // stale connection
      app.phase = p;
      app.phaseDetail = detail ?? "";
      if (p === "failed") {
        app.caps = [];
        app.lastError = detail ?? "authentication failed";
        pushToast("err", `Connection failed: ${app.lastError}`);
        app.needsToken = true;
        localStorage.removeItem("dextui.token");
      }
      if (p === "reconnecting") {
        if (wantNewSession) {
          wantNewSession = false;
          newSessionBaseline.clear();
        }
        pushToast("warn", "Connection lost — reconnecting…");
      }
      if (p === "live") {
        // Snapshot capabilities into reactive state: conn.capabilities is a
        // plain mutated array, so deriveds can't track it directly.
        app.caps = [...c.capabilities];
        reconcileAfterReconnect = everLive;
        if (everLive) pushToast("ok", "Reconnected");
        // hello_ok's session list is delivered immediately after this callback;
        // reconcile ids there before resubscribing (host may have restarted).
        everLive = true;
      }
    },
    onSessionList: (sessions) => {
      if (app.conn !== c) return; // stale connection
      app.sessions = sessions;
      const ids = new Set(sessions.map((s) => s.id));
      // Host restart: an active id can disappear while the Connection's local
      // stores survive. Drop the stale selection; a reused id will be reset by
      // the next snapshot rather than displaying the old host's transcript.
      if (app.activeId && !ids.has(app.activeId)) app.activeId = "";
      if (reconcileAfterReconnect) {
        reconcileAfterReconnect = false;
        // Force a snapshot: a restarted host can reuse sess_001 and even the
        // same tail seq, which must replace (not resume) the old transcript.
        if (app.activeId) c.subscribe(app.activeId, true);
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
        // Auto-activate a live session only: waking a cold one would spawn an
        // agent process the user never asked for. Cold sessions open on click.
        const firstLive = sessions.find((s) => s.status === "live");
        if (firstLive) activate(firstLive.id);
      }
    },
    onControlError: (code, message) => {
      if (app.conn !== c) return; // stale connection
      // A failed session.open must not leave the new-session latch armed.
      if (wantNewSession) {
        wantNewSession = false;
        newSessionBaseline.clear();
      }
      app.lastError = `${code}: ${message}`;
      pushToast("err", `${code}: ${message}`);
    },
  });
  app.conn = c;
  c.connect();
  localStorage.setItem("dextui.token", token);
}

export function activate(id: string): void {
  app.activeId = id;
  const c = app.conn;
  if (!c) return;
  const meta = app.sessions.find((s) => s.id === id);
  if (meta && meta.status === "cold") c.openSession({ id });
  c.subscribe(id, true);
}

export function newSession(): void {
  const c = app.conn;
  if (!c || app.phase !== "live" || wantNewSession) return;
  wantNewSession = true;
  newSessionBaseline = new Set(app.sessions.map((s) => s.id));
  c.openSession();
}
