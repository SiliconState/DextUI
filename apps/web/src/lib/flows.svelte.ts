// Flow builder state: the canvas draft, the flow list for the active
// workspace, and the host round-trips (x-agentlinkd.flows.*). The host is the
// source of truth — the draft here is an editor buffer until saved.
import type { Envelope, FlowFile, FlowSummary } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export interface FlowDraft extends FlowFile {
  dirty?: boolean;
}

export const flows = $state({
  open: false,
  /** Workspace the builder edits (the active session's cwd, or the host's). */
  cwd: "",
  list: [] as FlowSummary[],
  /** The flow being edited (null = the list view). */
  draft: null as FlowDraft | null,
  /** Name pending deletion confirmation. */
  confirmDelete: "",
  /** Last compile preview (crew spec) for the current draft. */
  preview: "",
  /** Run just started: flow name (the crew rail shows the run itself). */
  started: "",
});

export function flowsEnabled(): boolean {
  return app.caps.includes("flows") && !!app.conn;
}

function workspaceCwd(): string {
  return app.sessions.find((s) => s.id === app.activeId)?.cwd || flows.cwd || "";
}

/** Open the builder: list flows for the active workspace (or show the list empty). */
export function openFlows(): void {
  const c = app.conn;
  if (!c) return;
  flows.open = true;
  flows.cwd = workspaceCwd() || flows.cwd;
  flows.started = "";
  c.flowsList(flows.cwd || undefined);
}

export function closeFlows(): void {
  flows.open = false;
  flows.draft = null;
  flows.preview = "";
  flows.confirmDelete = "";
}

export function refreshFlows(): void {
  app.conn?.flowsList(flows.cwd || undefined);
}

export function openFlow(name: string): void {
  flows.confirmDelete = "";
  app.conn?.flowsGet(name, flows.cwd || undefined);
}

export function newFlow(): void {
  flows.draft = {
    version: 1,
    name: "my-flow",
    title: "My flow",
    nodes: [],
    edges: [],
    dirty: true,
  };
  flows.confirmDelete = "";
  flows.preview = "";
}

export function saveFlow(): void {
  const d = flows.draft;
  const c = app.conn;
  if (!d || !c) return;
  c.flowsPut({ ...d, dirty: undefined } as FlowFile, flows.cwd || undefined);
}

export function deleteFlow(name: string): void {
  if (flows.confirmDelete !== name) {
    flows.confirmDelete = name;
    return;
  }
  flows.confirmDelete = "";
  app.conn?.flowsDelete(name, flows.cwd || undefined);
  if (flows.draft?.name === name) flows.draft = null;
}

/** Compile preview: shows the exact crew spec a run would use. */
export function compileFlow_(): void {
  const d = flows.draft;
  const c = app.conn;
  if (!d || !c) return;
  if (d.dirty) {
    saveFlow(); // compile reads the saved file
    pushToast("info", "Saved first — compiling the saved flow");
  }
  c.flowsCompile(d.name, flows.cwd || undefined);
}

export function runFlow(): void {
  const d = flows.draft;
  const c = app.conn;
  if (!d || !c) return;
  if (d.dirty) saveFlow();
  flows.started = "";
  c.flowsRun(d.name, flows.cwd || undefined);
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onFlowsControl(env: Envelope): void {
  if (env.event === "x-agentlinkd.flows.list" || env.event === "x-agentlinkd.flows.changed") {
    const d = env.data as { cwd: string; flows: FlowSummary[] };
    if (d?.cwd === flows.cwd || !flows.cwd) {
      flows.cwd = d.cwd;
      flows.list = [...(d.flows ?? [])];
    }
    return;
  }
  if (env.event === "x-agentlinkd.flows.get") {
    const d = env.data as { cwd: string; flow: FlowFile };
    if (d?.flow) flows.draft = { ...d.flow, dirty: false };
    return;
  }
  if (env.event === "x-agentlinkd.flows.put") {
    const d = env.data as { flow: FlowFile };
    if (d?.flow?.name === flows.draft?.name) flows.draft.dirty = false;
    return;
  }
  if (env.event === "x-agentlinkd.flows.compile") {
    const d = env.data as { spec: unknown };
    flows.preview = JSON.stringify(d?.spec ?? null, null, 2);
    return;
  }
  if (env.event === "x-agentlinkd.flows.run") {
    const d = env.data as { name: string; started?: boolean; error?: string };
    if (d?.error) {
      pushToast("err", `Flow '${d.name}': ${d.error}`);
      return;
    }
    if (d?.started) {
      flows.started = d.name;
      pushToast("ok", `Flow '${d.name}' is running — watch it in the crew rail (runs list)`);
    }
    return;
  }
  if (env.event === "error") {
    const d = env.data as { code: string; message: string; cmd?: string };
    if (typeof d?.cmd === "string" && d.cmd.startsWith("x-agentlinkd.flows.")) pushToast("warn", d.message);
  }
}
