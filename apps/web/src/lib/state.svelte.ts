// App-level reactive state bridging the framework-free Connection into Svelte 5 runes.

import { Connection, type ConnPhase } from "@dextui/client";
import type { SessionMeta } from "@dextui/protocol";

export type Theme = "dark" | "light";
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
  paletteOpen: false,
  theme: "dark" as Theme,
  toasts: [] as Toast[],
});

let started = false;
let everLive = false;
let wantNewSession = false;
const knownIds = new Set<string>();
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

function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function toggleTheme(): void {
  app.theme = app.theme === "dark" ? "light" : "dark";
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
  const stored = (localStorage.getItem("dextui.theme") as Theme | null) ?? null;
  const theme = stored ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  app.theme = theme;
  applyTheme(theme);
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
        app.lastError = detail ?? "authentication failed";
        pushToast("err", `Connection failed: ${app.lastError}`);
        app.needsToken = true;
        localStorage.removeItem("dextui.token");
      }
      if (p === "reconnecting") pushToast("warn", "Connection lost — reconnecting…");
      if (p === "live") {
        if (everLive) pushToast("ok", "Reconnected");
        // Server subscriptions die with the socket; resubscribe after any reconnect.
        if (everLive && app.activeId) c.subscribe(app.activeId);
        everLive = true;
      }
    },
    onSessionList: (sessions) => {
      if (app.conn !== c) return; // stale connection
      app.sessions = sessions;
      // A session we haven't seen before appeared after we asked for one: switch to it.
      if (wantNewSession) {
        const fresh = sessions.find((s) => !knownIds.has(s.id));
        if (fresh) {
          wantNewSession = false;
          activate(fresh.id);
        }
      }
      for (const s of sessions) knownIds.add(s.id);
      if (!app.activeId && sessions.length > 0) {
        // Auto-activate a live session only: waking a cold one would spawn an
        // agent process the user never asked for. Cold sessions open on click.
        const firstLive = sessions.find((s) => s.status === "live");
        if (firstLive) activate(firstLive.id);
      }
    },
    onControlError: (code, message) => {
      if (app.conn !== c) return; // stale connection
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
  c.subscribe(id);
}

export function newSession(): void {
  const c = app.conn;
  if (!c) return;
  wantNewSession = true;
  c.openSession();
}
