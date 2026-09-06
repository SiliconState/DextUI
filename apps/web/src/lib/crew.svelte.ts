// Crew run store: the third first-class noun (runs) beside sessions and
// decisions. Host-pushed summaries feed all three tiers (ticker, rail,
// sheet); only the open sheet fetches detail, and only one tail pane exists.
// Escalations are the sole decision here — they join the Action Queue count
// (see queueTotal in state.svelte.ts); everything else is observation.

import type {
  CrewControlEvent,
  CrewFileReply,
  CrewRunDetail,
  CrewRunSummary,
  CrewTailReply,
  CrewsPayload,
  Envelope,
} from "@dextui/protocol";
import { CREW_EXT } from "@dextui/protocol";
import { app, pushToast } from "./state.svelte";

export type CrewRun = CrewRunSummary & { /** client receive time; ages tick from here */ at: number };

export const crew = $state({
  runs: [] as CrewRun[],
  omitted: 0,
  /** Sheet subscription: id first (open sent), detail when the host answers. */
  openId: "",
  open: null as CrewRunDetail | null,
  openAt: 0,
  /** The one tail pane per sheet. */
  tailWorker: "",
  tail: null as (CrewTailReply & { at: number }) | null,
  tailPending: false,
  file: null as CrewFileReply | null,
  /** Resume in flight (first answer wins; the host rejects the loser). */
  answering: false,
  stopping: false,
  railOpen: localStorage.getItem("dextui.crewsOpen") !== "0",
  railAll: false,
});

export function crewEnabled(): boolean {
  return app.phase === "live" && app.caps.includes("crew");
}

/** Open decisions: paused runs with an escalation (never `paused_reason` alone). */
export function crewEscalations(): CrewRun[] {
  return crew.runs.filter((r) => r.status === "paused" && !!r.escalation);
}

/** Runs that justify a ticker: anything not terminal. */
export function crewLive(): CrewRun[] {
  return crew.runs.filter((r) => r.status === "running" || r.status === "pending" || r.status === "paused");
}

/** Host order is attention order (paused → failed → running → …). */
export function crewTop(): CrewRun | undefined {
  return crew.runs[0];
}

/** Host ages are frozen at push time; add the client-side elapsed since receipt. */
export function crewAge(r: { age_ms: number; at?: number }, now: number): number {
  return r.age_ms + (r.at ? Math.max(0, now - r.at) : 0);
}
export function crewIdle(r: { updated_ms: number; at?: number }, now: number): number {
  return r.updated_ms + (r.at ? Math.max(0, now - r.at) : 0);
}

export function toggleCrewRail(): void {
  crew.railOpen = !crew.railOpen;
  localStorage.setItem("dextui.crewsOpen", crew.railOpen ? "1" : "0");
}

export function shortRun(id: string): string {
  return id.slice(0, 8); // "run-8ee9"
}

export function crewDur(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export const GLYPH: Record<string, string> = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  paused: "⚠",
  stopped: "✗",
};

const notified = new Set<string>();

function notifyEscalation(r: CrewRunSummary): void {
  if (notified.has(r.id)) return;
  notified.add(r.id);
  if (app.notify !== "on" || !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(`crew ${shortRun(r.id)} needs an answer`, {
      body: (r.escalation?.question ?? r.task).slice(0, 120),
      tag: `crew:${r.id}`,
      icon: "/icon.svg",
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      openRun(r.id);
      n.close();
    };
  } catch {
    /* platform rejects the constructor */
  }
}

/** Wire boundary for hello_ok.crews and every x-agentlinkd.crew.changed. */
export function acceptCrews(payload: CrewsPayload): void {
  const at = Date.now();
  const runs = (payload?.runs ?? []).filter((r) => r && typeof r.id === "string");
  crew.runs = runs.map((r) => ({ ...r, at, counts: { ...r.counts }, ...(r.escalation ? { escalation: { ...r.escalation } } : {}) }));
  crew.omitted = payload?.omitted ?? 0;
  for (const r of crew.runs) {
    if (r.status === "paused" && r.escalation) notifyEscalation(r);
    else notified.delete(r.id);
  }
  // A run that vanished from disk while its sheet is open: keep the last
  // snapshot visible but flag it so actions disappear.
  if (crew.openId && crew.open && !crew.runs.some((r) => r.id === crew.openId) && crew.omitted === 0) {
    crew.open = { ...crew.open, status: "failed", state: "stopped", paused_reason: "run directory removed" };
  }
  // A resume/stop we were waiting on has landed as state; unstick the buttons.
  const open = crew.runs.find((r) => r.id === crew.openId);
  if (open && crew.answering && open.status !== "paused") crew.answering = false;
  if (open && crew.stopping && open.status !== "running" && open.status !== "pending") crew.stopping = false;
}

export function openRun(id: string): void {
  const c = app.conn;
  if (!c || !crewEnabled()) return;
  if (crew.openId && crew.openId !== id) c.crewClose(crew.openId);
  if (crew.openId !== id) {
    crew.open = null;
    crew.tail = null;
    crew.tailWorker = "";
    crew.file = null;
  }
  crew.openId = id;
  app.galleryOpen = false;
  c.crewOpen(id);
}

export function closeRun(): void {
  const c = app.conn;
  if (crew.openId && c) c.crewClose(crew.openId);
  crew.openId = "";
  crew.open = null;
  crew.tail = null;
  crew.tailWorker = "";
  crew.tailPending = false;
  crew.file = null;
  crew.answering = false;
  crew.stopping = false;
}

/** Focus a worker's log in the single tail pane (swap source, never add a pane). */
export function requestTail(worker: string): void {
  const c = app.conn;
  if (!c || !crew.openId) return;
  if (crew.tailWorker === worker && crew.tail && !crew.tailPending) {
    // Toggle off on the same row; refresh happens through refreshTail().
    crew.tailWorker = "";
    crew.tail = null;
    return;
  }
  crew.tailWorker = worker;
  crew.tailPending = true;
  c.crewTail(crew.openId, worker);
}

export function refreshTail(): void {
  const c = app.conn;
  if (!c || !crew.openId || !crew.tailWorker) return;
  crew.tailPending = true;
  c.crewTail(crew.openId, crew.tailWorker);
}

export function openFile(path: string): void {
  const c = app.conn;
  if (!c || !crew.openId) return;
  crew.file = null;
  c.crewFile(crew.openId, path);
}

export function stopRun(id: string): void {
  const c = app.conn;
  if (!c) return;
  crew.stopping = true;
  c.crewStop(id);
}

export function answerRun(id: string, answer: string): boolean {
  const c = app.conn;
  const text = answer.trim();
  if (!c || !text || crew.answering) return false;
  crew.answering = true;
  c.crewResume(id, text);
  return true;
}

/** Control-plane tap (registered from state.svelte.ts). */
export function onCrewControl(env: Envelope): void {
  switch (env.event) {
    case `${CREW_EXT}.run`: {
      const d = env.data as CrewRunDetail;
      if (d && d.id === crew.openId) {
        crew.open = d;
        crew.openAt = Date.now();
      }
      return;
    }
    case `${CREW_EXT}.tail`: {
      const d = env.data as CrewTailReply;
      if (d && d.run === crew.openId && d.worker === crew.tailWorker) {
        crew.tail = { ...d, lines: [...(d.lines ?? [])], at: Date.now() };
      }
      crew.tailPending = false;
      return;
    }
    case `${CREW_EXT}.file`: {
      const d = env.data as CrewFileReply;
      if (d && d.run === crew.openId) crew.file = d;
      return;
    }
    case `${CREW_EXT}.control`: {
      const d = env.data as CrewControlEvent;
      if (!d) return;
      if (d.verb === "resume") crew.answering = false;
      if (d.verb === "stop") crew.stopping = false;
      // Broadcast to every client so all tabs see the same truth; the toast is
      // the receipt, the state flip arrives via x-agentlinkd.crew.changed.
      pushToast(d.ok ? "ok" : "err", `crew ${shortRun(d.run)} · ${d.verb} ${d.ok ? "✓" : "✗"}${d.message ? ` · ${d.message}` : ""}`);
      return;
    }
    case "hello_ok": {
      // A reconnect (host restart or not) drops the host's per-client open set;
      // re-subscribe so an open sheet keeps receiving detail.
      if (crew.openId) app.conn?.crewOpen(crew.openId);
      return;
    }
    case "error": {
      // Control errors carry no correlation id: any error while a verb is in
      // flight releases the button rather than leaving it stuck forever.
      const d = env.data as { code?: string };
      if (crew.answering) crew.answering = false;
      if (crew.stopping) crew.stopping = false;
      if (d?.code === "no_log" || d?.code === "no_worker" || d?.code === "no_run") crew.tailPending = false;
      return;
    }
    default:
      return;
  }
}
