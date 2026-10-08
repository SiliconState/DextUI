import type { SessionState } from "@dextui/client";

export type HeaderTarget = "progress" | "approval" | "error" | "result";
export type HeaderStatus = { label: string; tone: "blue" | "amber" | "green" | "red" | "neutral"; target: HeaderTarget; busy: boolean; step: string; progress?: { current: number; total: number } };

/** Presentation only: do not infer historic outcome, retries or an invented total. */
export function headerStatus(view: SessionState | null, phase: string): HeaderStatus {
  const base: HeaderStatus = { label: "Idle", tone: "neutral", target: "result", busy: false, step: "" };
  if (phase !== "live") return { ...base, label: "Offline", tone: phase === "failed" ? "red" : "neutral", target: "error" };
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
  if (view.pending.size || view.pendingUi) return { ...base, label: "Needs input", tone: "amber", target: "approval", busy, step: view.pendingUi?.params.title || [...view.pending.values()][0]?.summary || "Waiting for your decision", progress: measured };
  if (busy) return { ...base, label: "Active", tone: "blue", target: "progress", busy, step, progress: measured };
  if (view.failed) return { ...base, label: "Error", tone: "red", target: "error" };
  if (view.status === "cold" || view.status === "exited") return { ...base, label: "Offline", target: "error" };
  // Completed/stopped turns are not task-success claims. The agent is idle.
  return base;
}

export function headerModel(model?: string, effort?: string): { model: string; shortModel: string; effort: string; shortEffort: string; effortTone: string } {
  const raw = model?.split("/").at(-1)?.trim() || "Unknown";
  let label = raw.replace(/^claude-/i, "").replace(/-(?:latest|\d{8})$/i, "");
  const family = /^(opus|sonnet|haiku)[- ]([\d]+)(?:[-.]([\d]+))?/i.exec(label);
  if (family) label = `${family[1]![0]!.toUpperCase()}${family[1]!.slice(1)} ${family[2]}${family[3] ? `.${family[3]}` : ""}`;
  else label = label.replace(/^gpt-/i, "GPT ").replace(/-sol$/i, "").replace(/-codex$/i, " C");
  // A compact display alias, never a changed provider/model selection. Full
  // authoritative values stay in the trigger's title/accessible name and menu.
  if (label.length > 13) label = label.replace(/[-_]/g, " ").split(" ").slice(0, 2).join(" ");
  if (label.length > 13) label = `${label.slice(0, 12)}…`;
  const effortLabel = effort ? effort === "xhigh" ? "X-high" : effort[0]!.toUpperCase() + effort.slice(1) : "Unknown";
  const shortModel = !model ? "?" : family ? label.split(" ")[0]! : /^GPT /.test(label) ? label : label.split(" ")[0]!;
  const shortEffort = !effort ? "?" : effort === "medium" ? "Med" : effort === "minimal" ? "Min" : effort === "xhigh" ? "X-hi" : effortLabel;
  const effortColors: Partial<Record<string, string>> = { off: "var(--dim)", minimal: "var(--dim)", low: "var(--green)", medium: "var(--cyan)", high: "var(--blue)", xhigh: "var(--magenta)", max: "var(--orange)" };
  const effortTone = Object.hasOwn(effortColors, effort ?? "") ? effortColors[effort!]! : "var(--dim)";
  return { model: label, shortModel, effort: effortLabel, shortEffort, effortTone };
}

export function headerContext(view: SessionState | null): { used?: number; window: number; pct?: number; assumed: boolean } {
  const reported = view?.diagnostics?.context_window;
  const window = reported && Number.isFinite(reported) && reported > 0 ? reported : 200_000;
  const used = view?.contextTokens ?? (view?.contextChars !== undefined ? Math.ceil(view.contextChars / 4) : undefined);
  const valid = used !== undefined && Number.isFinite(used) && used >= 0 ? used : undefined;
  return { used: valid, window, pct: valid === undefined ? undefined : Math.min(100, Math.round(valid / window * 100)), assumed: window !== reported };
}
