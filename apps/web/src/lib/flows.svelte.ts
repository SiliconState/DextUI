// Flow builder state: the canvas draft, the flow list for the active
// workspace, and the host round-trips (x-agentlinkd.flows.*). The host is the
// source of truth — the draft here is an editor buffer until saved.
import type { Envelope, FlowFile, FlowLaunch, FlowSummary, FlowTrigger, TriggerStatus } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export interface FlowDraft extends FlowFile {
  dirty?: boolean;
  /** Revision of the SAVED file this draft mirrors (host-reported mtime). */
  rev?: number;
}

export const flows = $state({
  open: false,
  /** Workspace the builder edits (the active session's cwd, or the host's). */
  cwd: "",
  list: [] as FlowSummary[],
  /** Armed triggers for the workspace (host-reported). */
  triggers: [] as TriggerStatus[],
  /** Last launch per flow: a run that "started" may still have failed. */
  launches: [] as FlowLaunch[],
  /** Executor this host can run flows with ("crew"), "" when runs are
   *  refused (no engine). Defaults optimistic so older hosts keep working;
   *  the list reply is authoritative. */
  executor: "crew",
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
  // A dirty flow draft is the user's call to discard, not a default.
  if (flows.draft?.dirty && !window.confirm("Discard unsaved changes to this flow?")) return;
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

/** Pending flows.put acknowledgements, in send order (the host replies in
 *  order). Each waiter remembers the exact bytes it awaits, so a reply can
 *  only clear the dirty flag — or hand a run its revision — for the save that
 *  produced it. A double-clicked Run/Compile can neither hang the first
 *  waiter nor ack the wrong revision. */
interface SaveWaiter {
  name: string;
  /** JSON of the flow exactly as sent (dirty/rev stripped). */
  snapshot: string;
  resolve: (rev: number | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}
const saveWaiters: SaveWaiter[] = [];

function flowSnapshot(d: FlowDraft): string {
  return JSON.stringify({ ...d, dirty: undefined, rev: undefined });
}

/** Settle the OLDEST waiter for `name` (replies arrive in send order). */
function settleSave(name: string, rev: number | undefined): SaveWaiter | undefined {
  const i = saveWaiters.findIndex((w) => w.name === name);
  if (i < 0) return undefined;
  const [w] = saveWaiters.splice(i, 1);
  if (!w) return undefined;
  clearTimeout(w.timer);
  w.resolve(rev);
  return w;
}

function saveFlowAckd(): Promise<number | undefined> {
  const d = flows.draft;
  const c = app.conn;
  if (!d || !c) return Promise.resolve(undefined);
  const snapshot = flowSnapshot(d);
  return new Promise((resolve) => {
    let w: SaveWaiter | undefined;
    const timer = setTimeout(() => {
      const i = saveWaiters.indexOf(w ?? ({} as SaveWaiter));
      if (w && i >= 0) saveWaiters.splice(i, 1);
      resolve(undefined); // no ack in 8 s: treat as a failed save, never run it
    }, 8000);
    w = { name: d.name, snapshot, resolve, timer };
    saveWaiters.push(w);
    c.flowsPut({ ...d, dirty: undefined } as FlowFile, flows.cwd || undefined);
  });
}

export function saveFlow(): void {
  void saveFlowAckd();
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
export async function compileFlow_(): Promise<void> {
  const d = flows.draft;
  const c = app.conn;
  if (!d || !c) return;
  if (d.dirty) {
    // Compile reads the saved file — wait for the save ack so the preview is
    // never compiled from a stale revision.
    const rev = await saveFlowAckd();
    if (app.conn !== c || flows.draft !== d) return; // left the editor mid-save
    if (rev === undefined) {
      pushToast("err", "Compile stopped — the flow could not be saved (see the error)");
      return;
    }
    d.rev = rev;
    pushToast("info", "Saved first — compiling the saved flow");
  }
  c.flowsCompile(d.name, flows.cwd || undefined);
}

let runBusy = false;
export async function runFlow(): Promise<void> {
  if (runBusy) return; // a double-click must not queue a second launch
  runBusy = true;
  try {
    const d = flows.draft;
    const c = app.conn;
    if (!d || !c) return;
    let rev = d.rev;
    // Save first and WAIT for the acknowledged revision: a rejected save must
    // not fall through to running previously saved (different) instructions.
    // If the editor keeps changing under the saves, stop — the user must be
    // able to see exactly what runs.
    for (let attempt = 0; d.dirty && attempt < 3; attempt++) {
      const saved = await saveFlowAckd();
      if (app.conn !== c || flows.draft !== d) return; // left the editor mid-save
      if (saved === undefined) {
        pushToast("err", "Run stopped — the flow could not be saved (see the error)");
        return;
      }
      rev = saved;
    }
    if (d.dirty) {
      pushToast("err", "Run stopped — the editor kept changing while saving. Settle your edits, then run");
      return;
    }
    flows.started = "";
    c.flowsRun(d.name, flows.cwd || undefined, rev);
  } finally {
    runBusy = false;
  }
}

/** Trigger editing on the draft (host validates on save). */
export function addTrigger(kind: FlowTrigger["kind"]): void {
  const d = flows.draft;
  if (!d) return;
  const t: FlowTrigger = { kind, enabled: true };
  if (kind === "schedule") t.daily_at = "09:00";
  if (kind === "watch") t.path = ".";
  if (kind === "mesh") t.node = d.name;
  d.triggers = [...(d.triggers ?? []), t];
  d.dirty = true;
}

export function removeTrigger(i: number): void {
  const d = flows.draft;
  if (!d?.triggers) return;
  d.triggers = d.triggers.filter((_, k) => k !== i);
  d.dirty = true;
}

export function hookFor(name: string): string | undefined {
  return flows.triggers.find((t) => t.name === name && t.kind === "webhook")?.hook;
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onFlowsControl(env: Envelope): void {
  if (env.event === "x-agentlinkd.flows.list" || env.event === "x-agentlinkd.flows.changed") {
    const d = env.data as { cwd: string; flows: FlowSummary[]; triggers?: TriggerStatus[]; launches?: FlowLaunch[] };
    if (d?.cwd === flows.cwd || !flows.cwd) {
      flows.cwd = d.cwd;
      flows.list = [...(d.flows ?? [])];
      flows.triggers = [...(d.triggers ?? [])];
      flows.launches = [...(d.launches ?? [])];
      if (d && "executor" in d) flows.executor = typeof d.executor === "string" ? d.executor : "";
    }
    return;
  }
  if (env.event === "x-agentlinkd.flows.trigger") {
    // Phases come from the host: "pending" (coalesced while busy), "start"
    // (launch accepted), "failed" (launch/process failed, with retry_at).
    const d = env.data as { name: string; kind: string; reason: string; phase?: string; error?: string; retry_at?: number };
    if (d?.phase === "failed") {
      const retry = d.retry_at ? ` — retrying ${new Date(d.retry_at).toLocaleTimeString()}` : "";
      pushToast("err", `Flow '${d.name}' trigger failed: ${((d.error ?? "run failed").split("\n")[0] ?? "").slice(0, 140)}${retry}`);
      return;
    }
    const queued = d?.phase === "pending";
    pushToast(queued ? "info" : "ok", `Flow '${d.name}' ${queued ? "queued" : "started"} by ${d.kind}: ${d.reason}`);
    return;
  }
  if (env.event === "x-agentlinkd.flows.get") {
    const d = env.data as { cwd: string; flow: FlowFile; rev?: number };
    if (d?.flow) flows.draft = { ...d.flow, dirty: false, rev: d.rev };
    return;
  }
  if (env.event === "x-agentlinkd.flows.put") {
    const d = env.data as { flow: FlowFile; rev?: number };
    const w = settleSave(d?.flow?.name ?? "", typeof d?.rev === "number" ? d.rev : undefined);
    // Only the save whose bytes are still in the editor may clear the dirty
    // flag; a reply for superseded bytes must leave newer keystrokes dirty.
    if (d?.flow?.name === flows.draft?.name && w?.snapshot === flowSnapshot(flows.draft)) {
      flows.draft.dirty = false;
      if (typeof d.rev === "number") flows.draft.rev = d.rev;
    }
    return;
  }
  if (env.event === "x-agentlinkd.flows.compile") {
    const d = env.data as { spec: unknown };
    flows.preview = JSON.stringify(d?.spec ?? null, null, 2);
    return;
  }
  if (env.event === "x-agentlinkd.flows.run") {
    const d = env.data as { name: string; started?: boolean; error?: string; failed?: boolean; launch?: FlowLaunch };
    if (d?.error && !d.launch) {
      pushToast("err", `Flow '${d.name}': ${d.error}`);
      return;
    }
    // Launch tracking: spawn accepted (starting) or the process result.
    const launch = d?.launch;
    if (launch?.state === "failed") {
      const first = launch.error?.split("\n")[0] ?? "";
      const detail = first ? `: ${first.slice(0, 160)}` : "";
      pushToast("err", `Flow '${d.name}' run failed${detail}`);
      app.conn?.flowsList(flows.cwd || undefined);
      return;
    }
    if (launch?.state === "started" && launch.by && launch.by !== "user") {
      pushToast("ok", `Flow '${d.name}' finished`);
      app.conn?.flowsList(flows.cwd || undefined);
      return;
    }
    if (d?.started) {
      flows.started = d.name;
      pushToast("info", `Flow '${d.name}' launched — watch it in the crew rail (runs list)`);
    }
    return;
  }
  if (env.event === "error") {
    const d = env.data as { code: string; message: string; cmd?: string };
    if (typeof d?.cmd === "string" && d.cmd.startsWith("x-agentlinkd.flows.")) {
      if (d.cmd === "x-agentlinkd.flows.put") settleSave(flows.draft?.name ?? "", undefined); // save failed: unblock (and stop) run/compile
      pushToast("warn", d.message);
    }
  }
}
