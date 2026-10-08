import type { SessionState } from "@dextui/client";

export type HeaderTarget = "progress" | "approval" | "error" | "result";
export type HeaderStatus = { label: string; tone: "blue" | "amber" | "green" | "red" | "neutral"; target: HeaderTarget; busy: boolean; step: string; progress?: { current: number; total: number } };

/** Presentation only: do not infer historic outcome, retries or an invented total. */
export function headerStatus(view: SessionState | null, phase: string): HeaderStatus {
  const base: HeaderStatus = { label: "Idle", tone: "neutral", target: "result", busy: false, step: "" };
  if (phase !== "live") return { ...base, label: phase === "failed" || phase === "closed" ? "Offline" : "Connecting", tone: phase === "failed" ? "red" : "neutral", target: "error" };
  if (!view) return base;
  let start = 0;
  for (let i = view.blocks.length - 1; i >= 0; i--) if (view.blocks[i]?.kind === "user") { start = i + 1; break; }
  const turn = view.blocks.slice(start);
  const busy = view.working || view.compacting;
  const tool = turn.filter((block) => block.kind === "tool" && (block.status === "running" || block.status === "preview")).at(-1);
  const progress = [...view.uiProgress.values()].filter((item) => item.params.state === "running").at(-1)?.params;
  const current = progress?.current;
  const total = progress?.total;
  const measured = current !== undefined && total !== undefined && Number.isFinite(current) && Number.isFinite(total) && total > 0 && current >= 0 && current <= total ? { current, total } : undefined;
  const step = view.retry ? `Retry ${view.retry.attempt} · ${view.retry.reason}` : view.compacting ? "Compacting context" : progress ? `${measured ? `${measured.current} of ${measured.total} · ` : ""}${progress.message || progress.title}` : tool?.kind === "tool" ? tool.summary || tool.name : view.activePack ? `Running ${view.activePack}` : "Working on your request";
  if (view.pending.size || view.pendingUi) return { ...base, label: "Review", tone: "amber", target: "approval", busy, step: view.pendingUi?.params.title || [...view.pending.values()][0]?.summary || "Waiting for your decision", progress: measured };
  if (busy) return { ...base, label: "Working", tone: "blue", target: "progress", busy, step, progress: measured };
  if (view.failed) return { ...base, label: "Failed", tone: "red", target: "error" };
  if (turn.some((block) => block.kind === "marker" && block.text === "Interrupted.")) return { ...base, label: "Stopped" };
  if (view.status === "cold" || view.status === "exited") return { ...base, label: "Closed" };
  if (turn.some((block) => (block.kind === "text" && block.complete) || block.kind === "view")) return { ...base, label: "Done", tone: "green" };
  return base;
}

export function headerContext(view: SessionState | null): { used?: number; window: number; pct?: number; assumed: boolean } {
  const reported = view?.diagnostics?.context_window;
  const window = reported && Number.isFinite(reported) && reported > 0 ? reported : 200_000;
  const used = view?.contextTokens ?? (view?.contextChars !== undefined ? Math.ceil(view.contextChars / 4) : undefined);
  const valid = used !== undefined && Number.isFinite(used) && used >= 0 ? used : undefined;
  return { used: valid, window, pct: valid === undefined ? undefined : Math.min(100, Math.round(valid / window * 100)), assumed: window !== reported };
}
