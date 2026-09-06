// Connectors + provider sign-in state. Connectors are external sources the
// host materialises as folders under <home>/Connected (x-agentlinkd.connectors.*);
// providers are model vendors dext can sign in to (x-agentlinkd.auth.*).
// Credentials pass through exactly once on their way to the host and are
// never stored here; listings arrive secret-free by contract.
import type { AuthStatusReply, ConnectorAuthEvent, ConnectorInfo, ConnectorKind, ConnectorsListReply, Envelope, ProviderAuth } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export const connectors = $state({
  items: [] as ConnectorInfo[],
  tools: { git: false, rclone: false, gh: false },
  root: "",
  loaded: false,
  /** An add/sync/push/remove is in flight from this tab. */
  pending: false,
  /** Connect form open inside the folder picker. */
  formOpen: false,
});

export const providers = $state({
  items: [] as ProviderAuth[],
  active: null as string | null,
  loaded: false,
  pending: false,
  /** Providers dialog open. */
  open: false,
});

/** OAuth sign-in for a drive kind. `waiting` = consent page open somewhere;
 *  `done` = the host holds a token under `ticket` until `add` consumes it. */
export const signin = $state({
  phase: "idle" as "idle" | "starting" | "waiting" | "done" | "error",
  kind: null as ConnectorKind | null,
  ticket: null as string | null,
  url: "",
  error: "",
});
// Tab pre-opened on the click that starts a sign-in (popup blockers only
// allow window.open inside a user gesture); pointed at the consent URL when
// the host replies. Not reactive state — it is a browser handle.
let signinTab: Window | null = null;

export const KIND_LABEL: Record<ConnectorKind, string> = {
  github: "GitHub",
  git: "Git",
  gdrive: "Google Drive",
  dropbox: "Dropbox",
};

export function connectorsEnabled(): boolean {
  return app.caps.includes("connectors") && !!app.conn;
}
export function providersEnabled(): boolean {
  return app.caps.includes("provider_auth") && !!app.conn;
}

export function loadConnectors(): void {
  if (!connectorsEnabled() || !app.conn) return;
  app.conn.connectorsList();
}
export function addConnector(opts: { kind: ConnectorKind; label: string; remote: string; secret?: string; ticket?: string }): void {
  if (!connectorsEnabled() || !app.conn) return;
  connectors.pending = true;
  app.conn.connectorsAdd(opts);
}

/** Start "Sign in with Google/Dropbox". Must run inside the click handler. */
export function startSignIn(kind: ConnectorKind): void {
  if (!connectorsEnabled() || !app.conn) return;
  if (signinTab && !signinTab.closed) signinTab.close();
  signinTab = window.open("", "_blank");
  if (signinTab) signinTab.document.title = "Signing in…";
  signin.phase = "starting";
  signin.kind = kind;
  signin.ticket = null;
  signin.url = "";
  signin.error = "";
  app.conn.connectorsAuthorize(kind);
}
/** Re-open the consent page (the pre-opened tab was closed or blocked). */
export function reopenSignIn(): void {
  if (!signin.url) return;
  // Keep the handle (no noopener) so `done` can close this tab too.
  signinTab = window.open(signin.url, "_blank");
}
export function relaySignIn(landing: string): void {
  if (!app.conn || !signin.ticket) return;
  app.conn.connectorsRelay(signin.ticket, landing);
}
export function cancelSignIn(): void {
  if (signinTab && !signinTab.closed) signinTab.close();
  signinTab = null;
  if (app.conn && signin.ticket) app.conn.connectorsCancelAuth(signin.ticket);
  signin.phase = "idle";
  signin.ticket = null;
  signin.url = "";
  signin.error = "";
}
/** After `add` consumed the ticket (or the form closed). */
export function resetSignIn(): void {
  signinTab = null;
  signin.phase = "idle";
  signin.kind = null;
  signin.ticket = null;
  signin.url = "";
  signin.error = "";
}
export function syncConnector(id: string): void {
  if (!connectorsEnabled() || !app.conn) return;
  connectors.pending = true;
  app.conn.connectorsSync(id);
}
export function pushConnector(id: string, message?: string): void {
  if (!connectorsEnabled() || !app.conn) return;
  connectors.pending = true;
  app.conn.connectorsPush(id, message);
}
export function removeConnector(id: string, purge = false): void {
  if (!connectorsEnabled() || !app.conn) return;
  connectors.pending = true;
  app.conn.connectorsRemove(id, purge);
}

/** The connector whose folder contains `cwd`, if any. */
export function connectorFor(cwd: string | undefined | null): ConnectorInfo | null {
  if (!cwd) return null;
  return connectors.items.find((c) => cwd === c.local || cwd.startsWith(c.local + "/")) ?? null;
}

export function openProviders(): void {
  if (!providersEnabled() || !app.conn) return;
  providers.open = true;
  if (!providers.loaded) app.conn.authStatus();
}
export function closeProviders(): void {
  providers.open = false;
}
export function loginProvider(id: string, credential: string): void {
  if (!providersEnabled() || !app.conn) return;
  providers.pending = true;
  app.conn.authLogin(id, credential);
}
export function logoutProvider(id: string): void {
  if (!providersEnabled() || !app.conn) return;
  providers.pending = true;
  app.conn.authLogout(id);
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onConnectorsControl(env: Envelope): void {
  if (env.event === "x-agentlinkd.connectors.list") {
    const d = env.data as ConnectorsListReply;
    if (!d || !Array.isArray(d.connectors)) return;
    connectors.items = d.connectors.map((c) => ({ ...c }));
    connectors.tools = { ...d.tools };
    connectors.root = d.root;
    connectors.loaded = true;
    if (d.added || d.removed || d.synced || d.pushed) connectors.pending = false;
    const by = (id: string) => connectors.items.find((c) => c.id === id)?.label ?? "connector";
    if (d.added) {
      const c = connectors.items.find((x) => x.id === d.added);
      if (c?.status === "error") pushToast("warn", `${c.label}: ${c.error ?? "could not connect"}`);
      else pushToast("ok", `Connected ${by(d.added)}`);
      connectors.formOpen = false;
      resetSignIn();
    }
    if (d.synced) pushToast("ok", `${by(d.synced)} is up to date`);
    if (d.pushed) pushToast("ok", `Pushed ${by(d.pushed)}`);
    if (d.removed) pushToast("ok", "Connector removed");
    return;
  }
  if (env.event === "x-agentlinkd.connectors.authorize") {
    const d = env.data as ConnectorAuthEvent;
    if (!d) return;
    // Only the attempt this tab started drives local state — the host also
    // broadcasts progress, and another tab's sign-in is not ours to adopt.
    if (signin.ticket && d.ticket !== signin.ticket) return;
    if (d.url && d.kind) {
      if (signin.phase !== "starting" && signin.phase !== "waiting") return; // another tab's sign-in
      const first = signin.phase === "starting";
      signin.ticket = d.ticket;
      signin.kind = d.kind;
      signin.url = d.url;
      signin.phase = "waiting";
      // The URL arrives twice (our reply + the broadcast); only the first one
      // navigates the pre-opened tab — a repeat would reload the consent page.
      if (first && signinTab && !signinTab.closed) {
        try { signinTab.location.href = d.url; } catch { signinTab = null; }
      }
      return;
    }
    if (d.cancelled) {
      if (signin.phase !== "idle") resetSignIn();
      return;
    }
    if (signin.phase !== "starting" && signin.phase !== "waiting") return;
    if (d.done) {
      signin.phase = "done";
      if (signinTab && !signinTab.closed) { try { signinTab.close(); } catch { /* cross-origin now */ } }
      signinTab = null;
      return;
    }
    if (d.error) {
      signin.phase = "error";
      signin.error = d.error;
      if (signinTab && !signinTab.closed) { try { signinTab.close(); } catch { /* ignore */ } }
      signinTab = null;
      return;
    }
    if (d.relayed) pushToast("ok", "Address received — finishing sign-in…");
    return;
  }
  if (env.event === "x-agentlinkd.auth.status") {
    const d = env.data as AuthStatusReply;
    if (!d || !Array.isArray(d.providers)) return;
    providers.items = d.providers.map((p) => ({ ...p }));
    providers.active = d.active;
    providers.loaded = true;
    if (Array.isArray(d.model_catalog)) app.modelCatalog = d.model_catalog.map((g) => ({ ...g, models: [...g.models] }));
    if (d.changed) {
      providers.pending = false;
      const p = providers.items.find((x) => x.id === d.changed);
      pushToast("ok", p && p.auth !== "none" ? `Signed in to ${p.label}` : `Signed out of ${p?.label ?? d.changed}`);
    }
    return;
  }
  if (env.event === "error") {
    const d = env.data as { code: string; message: string; cmd?: string };
    if (typeof d?.cmd !== "string") return;
    if (d.cmd.startsWith("x-agentlinkd.connectors.")) {
      connectors.pending = false;
      if (d.cmd.endsWith(".authorize") || d.cmd.endsWith(".relay")) {
        signin.phase = d.cmd.endsWith(".authorize") ? "error" : signin.phase;
        signin.error = d.message;
        if (signinTab && !signinTab.closed) { try { signinTab.close(); } catch { /* ignore */ } }
        signinTab = null;
      } else if (d.cmd.endsWith(".add") && d.code === "no_auth") {
        // The ticket died (consumed elsewhere, expired): back to the sign-in
        // button instead of a “Signed in” that can never connect.
        resetSignIn();
      }
      pushToast("warn", d.message);
    } else if (d.cmd.startsWith("x-agentlinkd.auth.")) {
      providers.pending = false;
      pushToast("warn", d.message);
    }
  }
}
