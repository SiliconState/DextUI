// Self-edit surface: DextUI rebuilding and restarting itself. Mirrors the
// host's x-agentlinkd.ui.* / x-agentlinkd.host.* extension. Every mutation
// goes through the host (or the agent's bash in a workbench session); this
// module only projects status and offers the one-click actions.
import type { Envelope, HostRestartEvent, SelfStatus, UiBuildEvent, UiRebuiltEvent } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export const selfEdit = $state({
  status: null as SelfStatus | null,
  /** Live build progress from broadcast events (null when idle). */
  build: null as { id: string; step: string; startedAt: number; by?: string } | null,
  /** A rebuilt event arrived for a build newer than this page; reload offered. */
  rebuilt: null as { id: string; by: string; rolledBack: boolean } | null,
  restartPending: null as { reason: string; by: string; busy: string[] } | null,
  /** The host said it is restarting: tabs show a quiet banner until reconnect. */
  restarting: false,
});

/** Build id this page was served from (vite stamps it into the SW URL). */
declare const __BUILD_ID__: string;
export function pageBuildId(): string {
  try {
    return typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "";
  } catch {
    return "";
  }
}

export function selfEditEnabled(): boolean {
  return app.caps.includes("self_edit") && !!selfEdit.status?.enabled;
}

/** The DextUI checkout the host runs from — the workbench session's cwd. */
export function workbenchCwd(): string | null {
  return selfEdit.status?.repo ?? null;
}

export function acceptSelf(status: SelfStatus): void {
  selfEdit.status = status;
  if (status.building) {
    selfEdit.build = { id: status.building.id, step: status.building.step, startedAt: status.building.started_at, by: status.building.by };
  } else {
    selfEdit.build = null;
  }
  selfEdit.restartPending = status.restart_pending
    ? { reason: status.restart_pending.reason, by: status.restart_pending.by, busy: [] }
    : null;
  // A fresh hello after a restart: the page may be older than what is served.
  const served = status.version?.id;
  const mine = pageBuildId();
  if (served && mine && served !== mine && !selfEdit.rebuilt) {
    selfEdit.rebuilt = { id: served, by: "host", rolledBack: false };
    offerReload(`This tab runs build ${mine}; the host serves ${served}.`);
  }
}

export function buildUi(opts: { tests?: boolean; check?: boolean } = {}): void {
  if (!selfEditEnabled() || !app.conn) return;
  if (selfEdit.build) {
    pushToast("warn", `A UI build is already running (${selfEdit.build.step})`);
    return;
  }
  app.conn.uiBuild(opts);
  pushToast("info", `Rebuilding the UI${opts.tests ? " with tests" : ""} — the served build stays until it passes`);
}

export function rollbackUi(): void {
  if (!selfEditEnabled() || !app.conn) return;
  if (!selfEdit.status?.lkg) {
    pushToast("warn", "No previous build to roll back to");
    return;
  }
  app.conn.uiRollback();
}

export function restartHost(reason = "", force = false): void {
  if (!selfEditEnabled() || !app.conn) return;
  app.conn.hostRestart(reason, force);
}

export function cancelRestart(): void {
  if (!selfEditEnabled() || !app.conn) return;
  app.conn.hostRestartCancel();
}

/** Open (or focus) a session whose cwd is this checkout, with auto-write so
 *  the agent can edit files. Seeds the composer with the self-edit contract. */
export function openWorkbench(): void {
  const cwd = workbenchCwd();
  const c = app.conn;
  if (!cwd || !c || app.phase !== "live") return;
  const existing = app.sessions.find((s) => s.cwd === cwd && s.status !== "exited");
  if (existing) {
    app.activeId = existing.id;
    if (existing.status === "cold") c.openSession({ id: existing.id });
    c.subscribe(existing.id);
    return;
  }
  app.pendingDraft = WORKBENCH_SEED;
  c.openSession({ cwd, approval: "auto-write" });
}

const WORKBENCH_SEED = [
  "You are editing DextUI itself (this checkout is the app you are running in).",
  "Rules: prefer adding an extension under apps/web/src/ext/ over editing core files; keep zero runtime deps; run `node packages/agentlinkd/scripts/ui-build.mjs` after web changes (staged build, swaps in only if svelte-check passes; open tabs reload themselves);",
  "for host changes (packages/agentlinkd/**) write `{\"reason\":\"…\"}` to the restart request file shown by /ui status — the host restarts after your turn ends.",
  "Task: ",
].join("\n");

let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function offerReload(why: string): void {
  const reload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    location.reload();
  };
  pushToast("ok", `${why} Reload to pick up the new build.`, { label: "reload", run: reload });
  // Hidden tabs reload on their own; a tab the human is looking at waits.
  if (document.hidden) {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (document.hidden) location.reload();
    }, 1500);
  }
}

function busyLabel(b: HostRestartEvent["busy"]): string[] {
  return (b ?? []).map((x) => (x.kind === "turn" ? `turn: ${x.title ?? x.session ?? ""}` : x.kind === "crew" ? `crew ${x.run?.slice(0, 8) ?? ""}` : x.kind));
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onSelfControl(env: Envelope): void {
  switch (env.event) {
    case "x-agentlinkd.ui.build": {
      const d = env.data as UiBuildEvent;
      if (d.phase === "start") selfEdit.build = { id: d.id, step: "start", startedAt: env.ts ?? Date.now(), by: d.by };
      else if (d.phase === "step") {
        if (selfEdit.build?.id === d.id) selfEdit.build = { ...selfEdit.build, step: d.step ?? "" };
        else selfEdit.build = { id: d.id, step: d.step ?? "", startedAt: env.ts ?? Date.now() };
      } else if (d.phase === "ok") {
        selfEdit.build = null;
      } else if (d.phase === "fail") {
        selfEdit.build = null;
        const where = d.failed ? ` at ${d.failed}` : "";
        pushToast("err", `UI build failed${where}: ${(d.tail ?? d.error ?? "").trim().split("\n").slice(-2).join(" · ").slice(0, 200) || d.error || "unknown"}. Served build untouched.`);
      }
      return;
    }
    case "x-agentlinkd.ui.rebuilt": {
      const d = env.data as UiRebuiltEvent;
      const id = d.version?.id ?? "";
      if (id && id === pageBuildId()) return; // this tab already runs it
      selfEdit.rebuilt = { id, by: d.by, rolledBack: !!d.rolled_back };
      offerReload(d.rolled_back ? "The UI was rolled back to the previous build." : `UI rebuilt${d.by === "external" ? " (from the workbench)" : ""}.`);
      return;
    }
    case "x-agentlinkd.host.restart": {
      const d = env.data as HostRestartEvent;
      if (d.phase === "pending") {
        const busy = busyLabel(d.busy);
        selfEdit.restartPending = { reason: d.reason ?? "", by: d.by ?? "", busy };
        if (busy.length && !d.force) pushToast("info", `Host restart queued — waits for ${busy.join(", ")}`, { label: "cancel", run: cancelRestart });
      } else if (d.phase === "cancelled") {
        selfEdit.restartPending = null;
        pushToast("info", "Host restart cancelled");
      } else if (d.phase === "restarting") {
        selfEdit.restartPending = null;
        selfEdit.restarting = true;
        pushToast("info", "Host restarting — this tab reconnects automatically");
      }
      return;
    }
    default:
      return;
  }
}

/** Reset transient flags when a connection goes live again. */
export function onSelfReconnected(): void {
  selfEdit.restarting = false;
}
