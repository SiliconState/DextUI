// Shared task workspace state: the task list for the active workspace, the
// record being edited, and the host round-trips (x-agentlinkd.tasks.*). The
// durable record at <cwd>/.dext/tasks/<name>.task.json is the source of truth
// — the draft here is an editor buffer until saved; agent-side edits arrive
// as `tasks.changed` and update the list live.
import type { Envelope, TaskRecord, TaskSummary } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export interface TaskDraft extends TaskRecord {
  dirty?: boolean;
  /** Set while a save is refused for stale rev: the buffer is authoritative
   *  until the user reloads or the disk moves again. */
  stale?: boolean;
}

export const TASK_STATUSES_UI: { value: TaskRecord["status"]; label: string }[] = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "dropped", label: "Dropped" },
];

export const tasks = $state({
  open: false,
  /** Workspace the panel edits (the active session's cwd, or the host's). */
  cwd: "",
  list: [] as TaskSummary[],
  /** Directory the records live in (shown so the agent's write surface is visible). */
  dir: "",
  /** The task being edited (null = the list view). */
  draft: null as TaskDraft | null,
  /** Name pending deletion confirmation. */
  confirmDelete: "",
});

export function tasksEnabled(): boolean {
  return app.caps.includes("tasks") && !!app.conn;
}

function workspaceCwd(): string {
  return app.sessions.find((s) => s.id === app.activeId)?.cwd || tasks.cwd || "";
}

export function openTasks(): void {
  const c = app.conn;
  if (!c) return;
  tasks.open = true;
  tasks.cwd = workspaceCwd() || tasks.cwd;
  tasks.confirmDelete = "";
  c.tasksList(tasks.cwd || undefined);
}

export function closeTasks(): void {
  // A dirty buffer is the user's call to make, not a default side effect.
  if (tasks.draft?.dirty && !window.confirm("Discard unsaved changes to this task?")) return;
  tasks.open = false;
  tasks.draft = null;
  tasks.confirmDelete = "";
  pendingTaskSave = ""; // its save reply no longer has a buffer to settle
}

export function refreshTasks(): void {
  app.conn?.tasksList(tasks.cwd || undefined);
}

export function openTask(name: string): void {
  tasks.confirmDelete = "";
  app.conn?.tasksGet(name, tasks.cwd || undefined);
}

/** New task buffer: a stub the host validates on first save. */
export function newTask(): void {
  tasks.draft = {
    version: 1,
    rev: 0,
    name: "",
    title: "",
    goal: "",
    acceptance: [],
    status: "planned",
    blocked_on: "",
    answer: "",
    constraints: { folders: [], budget_usd: null, notes: "" },
    links: { session: app.activeId, crew_run: "", flows: [] },
    artifacts: [],
    checks: [],
    summary: "",
    created_at: 0,
    updated_at: 0,
    updated_by: "user",
    dirty: true,
  };
  tasks.confirmDelete = "";
  pendingTaskSave = ""; // a fresh buffer supersedes any in-flight save
}

/** The record exactly as sent, so a save reply can tell whether the buffer
 *  moved on while the save was in flight (keystrokes during saving). */
let pendingTaskSave = "";

/** Save the buffer. `expectedRev` is the rev we based edits on — the host
 *  refuses with `stale_rev` instead of clobbering a concurrent writer (the
 *  agent may hold the same record). */
export function saveTask(): void {
  const d = tasks.draft;
  const c = app.conn;
  if (!d || !c) return;
  if (!d.name.trim()) {
    pushToast("warn", "The task needs a short name (lowercase, dashes)");
    return;
  }
  if (!d.goal.trim()) {
    pushToast("warn", "The task needs a goal — what does done mean?");
    return;
  }
  if (d.status === "blocked" && !d.blocked_on.trim()) {
    pushToast("warn", "A blocked task needs the question for the human");
    return;
  }
  const payload = { ...d, dirty: undefined, stale: undefined } as TaskRecord;
  pendingTaskSave = JSON.stringify(payload);
  c.tasksPut(payload, {
    cwd: tasks.cwd || undefined,
    expectedRev: d.rev > 0 ? d.rev : undefined,
    actor: "user",
  });
}

export function deleteTask(name: string): void {
  if (tasks.confirmDelete !== name) {
    tasks.confirmDelete = name;
    return;
  }
  tasks.confirmDelete = "";
  app.conn?.tasksDelete(name, tasks.cwd || undefined);
  if (tasks.draft?.name === name) {
    tasks.draft = null;
    pendingTaskSave = ""; // the deleted record's save reply has nowhere to land
  }
}

export function taskByStatus(status: TaskRecord["status"]): TaskSummary[] {
  return tasks.list.filter((t) => t.status === status);
}

/** Control-plane tap (wired from state.svelte.ts). */
export function onTasksControl(env: Envelope): void {
  if (env.event === "x-agentlinkd.tasks.list" || env.event === "x-agentlinkd.tasks.changed") {
    const d = env.data as { cwd: string; tasks: TaskSummary[]; dir?: string };
    if (d?.cwd === tasks.cwd || !tasks.cwd) {
      tasks.cwd = d.cwd;
      tasks.list = [...(d.tasks ?? [])];
      if (typeof d.dir === "string") tasks.dir = d.dir;
    }
    // An agent-side edit may have moved the record under the open editor:
    // surface the new rev without losing the buffer (the user re-reads if the
    // change matters — a silent overwrite is worse than a visible fork).
    if (tasks.draft && env.event === "x-agentlinkd.tasks.changed") {
      const s = (d.tasks ?? []).find((t) => t.name === tasks.draft?.name);
      if (s && s.rev > tasks.draft.rev) tasks.draft.stale = true;
    }
    return;
  }
  if (env.event === "x-agentlinkd.tasks.get") {
    const d = env.data as { cwd: string; task: TaskRecord };
    if (d?.cwd === tasks.cwd || !tasks.cwd) tasks.cwd = d.cwd;
    if (d?.task) {
      tasks.draft = { ...d.task, dirty: false, stale: false };
      pendingTaskSave = ""; // a reload supersedes any in-flight save of the old buffer
    }
    return;
  }
  if (env.event === "x-agentlinkd.tasks.put") {
    const d = env.data as { cwd: string; task: TaskRecord };
    if (d?.cwd && tasks.cwd && d.cwd !== tasks.cwd) return; // different workspace's save
    if (d?.task?.name === tasks.draft?.name) {
      const buffer = JSON.stringify({ ...tasks.draft, dirty: undefined, stale: undefined } as TaskRecord);
      if (buffer === pendingTaskSave) {
        tasks.draft = { ...d.task, dirty: false, stale: false };
      } else {
        // Keystrokes landed while the save was in flight: keep the NEWER
        // buffer (visibly dirty) and adopt the saved record's rev so the next
        // save is not a stale write.
        tasks.draft.rev = d.task.rev;
        tasks.draft.dirty = true;
        pushToast("ok", "Saved — newer edits are still in the editor (save again when ready)");
      }
      pendingTaskSave = "";
    }
    return;
  }
  if (env.event === "error") {
    const d = env.data as { code: string; message: string; cmd?: string };
    if (typeof d?.cmd === "string" && d.cmd.startsWith("x-agentlinkd.tasks.")) {
      if (d.cmd === "x-agentlinkd.tasks.put") pendingTaskSave = ""; // refused: no reply will settle it
      if (d.code === "stale_rev") {
        pushToast("err", "Not saved — the record changed (maybe the agent). Reload and re-apply", {
          label: "Reload",
          run: () => tasks.draft?.name && openTask(tasks.draft.name),
        });
      } else {
        pushToast("warn", d.message);
      }
    }
  }
}
