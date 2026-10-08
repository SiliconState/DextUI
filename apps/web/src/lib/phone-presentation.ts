import type { SessionState, ViewBlock } from "@dextui/client";

/** Metadata comes from completed shell envelopes and retained event timestamps,
 *  never from a line somewhere inside an arbitrary file/log being inspected. */
export function toolResultMetadata(block: ViewBlock, recent: SessionState["recent"] = []): { exitCode?: number; duration?: number } {
  if (block.kind !== "tool") return {};
  const result: { exitCode?: number; duration?: number } = {};
  if ((block.status === "ok" || block.status === "failed") && /^(bash|sh|shell)$/i.test(block.name)) {
    const content = block.content ?? "";
    const match = /^exit(?:_code| code)?:\s*(-?\d+)(?:\r?\n|$)/.exec(content);
    let code: unknown = match ? Number(match[1]) : undefined;
    if (!match) {
      try {
        const object: unknown = JSON.parse(content);
        if (object && typeof object === "object" && !Array.isArray(object)) code = (object as Record<string, unknown>).exit_code;
      } catch { /* Not a structured shell result. */ }
    }
    if (typeof code === "number" && Number.isSafeInteger(code)) result.exitCode = code;
  }
  const matching = recent.filter((event) => event.data && typeof event.data === "object" && (event.data as { call_id?: unknown }).call_id === block.call_id);
  const end = matching.filter((event) => event.event === "tool_call_result").at(-1);
  const start = end && matching.filter((event) => event.event === "tool_call_start" && event.ts <= end.ts).at(-1);
  if (start && end && Number.isFinite(start.ts) && Number.isFinite(end.ts) && end.ts >= start.ts) result.duration = (end.ts - start.ts) / 1000;
  return result;
}

/** Decode JSON only when it is a real serialized output, never unescape code. */
export function readableOutput(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      const streams = ["stdout", "stderr"].filter((key) => typeof object[key] === "string");
      if (streams.length) return streams.map((key) => `${key}\n${object[key]}`).join("\n\n");
      for (const key of ["output", "content", "text"]) if (typeof object[key] === "string") return object[key] as string;
    }
  } catch { /* Plain output is already readable. */ }
  return content;
}

export type PhoneItem =
  | { kind: "block"; id: number; block: ViewBlock }
  | { kind: "work"; id: number; blocks: ViewBlock[]; current: boolean };

const ADVISORY = /^(?:\[runtime-note\]\s*)?bash advisory:\s*/i;
// Only batch-start label lists are redundant; failure messages are not.
const BATCH = /^Batch: [a-z_][\w-]*: /i;
const BATCH_FAILURE = /^Batch: (\d+) tool call\(s\) failed\.?$/;
const RUNTIME_GUIDANCE = /^(?:\[runtime-note\]\s*)?(?:runtime guidance:|final objective warning:|queued update unresolved:)\s*\S/i;
const RUN_META = /^\[(?:objective:|phase:)/i;

/** Core emits shell guidance as Warn as well as Info/Note. Only this exact
 *  backend prefix is contained; ordinary warnings, errors and auth stay visible. */
export function isAdvisoryMarker(block: ViewBlock): boolean {
  return block.kind === "marker" && !block.auth && block.level !== "error" && ADVISORY.test(block.text.trim()) && block.text.trim().replace(ADVISORY, "").length > 0;
}

/** Exact core batch-result notice, not arbitrary warnings with a Batch prefix.
 *  Keep its full text in work details; never fold errors or authentication. */
export function isBatchFailureMarker(block: ViewBlock): boolean {
  return block.kind === "marker" && !block.auth && block.level !== "error" && BATCH_FAILURE.test(block.text.trim());
}

/** Only recognized backend runtime markers, never user/assistant prose. */
export function isRuntimeGuidanceMarker(block: ViewBlock): boolean {
  return block.kind === "marker" && !block.auth && block.level !== "error" && RUNTIME_GUIDANCE.test(block.text.trim());
}

/** Counts describe tool-call outcomes, not inferred task success or retries. */
export function phoneWorkCounts(blocks: ViewBlock[]): { total: number; passed: number; failed: number; running: number; pending: number } {
  const counts = { total: 0, passed: 0, failed: 0, running: 0, pending: 0 };
  for (const block of blocks) {
    if (block.kind !== "tool") continue;
    counts.total += 1;
    if (block.status === "ok") counts.passed += 1;
    else if (block.status === "failed") counts.failed += 1;
    else if (block.status === "running") counts.running += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** One readable clause for a tip line; the full text stays one tap away. */
export function tipSummary(text: string): string {
  const body = text.trim().replace(ADVISORY, "");
  const first = body.split(/[;.](?:\s|$)|\n/)[0]?.trim() || body;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export type WorkRow =
  | { kind: "step"; id: number; block: Extract<ViewBlock, { kind: "tool" }> }
  | { kind: "tip"; id: number; summary: string; text: string; count: number; warning: boolean }
  | { kind: "block"; id: number; block: ViewBlock };

/** Rows inside an expanded phone work group. Batch labels are redundant when
 *  tool rows are present; preserve them if execution stopped before any tool.
 *  Repeated identical shell guidance collapses into one tip with a count. */
export function phoneWorkRows(blocks: ViewBlock[]): WorkRow[] {
  const rows: WorkRow[] = [];
  // A later batch may never start, even if an earlier batch had tools. Drop
  // only labels followed by tool rows before the next batch-start boundary.
  const redundantBatches = new Set<number>();
  let followingTool = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool") followingTool = true;
    else if (block.kind === "marker" && !block.auth && (block.level === "info" || block.level === "note") && BATCH.test(block.text)) {
      if (followingTool) redundantBatches.add(block.id);
      followingTool = false;
    }
  }
  const tips = new Map<string, Extract<WorkRow, { kind: "tip" }>>();
  for (const block of blocks) {
    if (block.kind === "tool") rows.push({ kind: "step", id: block.id, block });
    else if (redundantBatches.has(block.id)) continue;
    else if (block.kind === "marker" && isAdvisoryMarker(block)) {
      const text = block.text.trim().replace(ADVISORY, "");
      const seen = tips.get(text);
      if (seen) { seen.count += 1; seen.warning ||= block.level === "warn"; }
      else { const tip = { kind: "tip" as const, id: block.id, summary: tipSummary(block.text), text, count: 1, warning: block.level === "warn" }; tips.set(text, tip); rows.push(tip); }
    } else rows.push({ kind: "block", id: block.id, block });
  }
  return rows;
}

/** One Copy action per visible phone turn, independent of trailing notices,
 *  reports or folded work. Prose stays lossless; only repetitive chrome changes. */
export function phoneCopyIds(blocks: ViewBlock[]): Set<number> {
  const ids = new Set<number>();
  let last: number | undefined;
  for (const block of blocks) {
    if (block.kind === "user") {
      if (last !== undefined) ids.add(last);
      last = undefined;
    } else if (block.kind === "text") last = block.id;
  }
  if (last !== undefined) ids.add(last);
  return ids;
}

/** Only presentation changes. Answers, real warnings, auth and compaction stay
 *  visible. In Show all, tool blocks remain rich but shell guidance and exact batch
 *  result notices still get a work container instead of assistant narration. */
export function phoneTranscriptItems(blocks: ViewBlock[], compact = true): PhoneItem[] {
  const groups = new Map<number, { blocks: ViewBlock[]; current: boolean }>();
  const skip = new Set<number>();
  let start = 0;
  for (let end = 0; end <= blocks.length; end++) {
    if (end < blocks.length && blocks[end]?.kind !== "user") continue;
    const work = blocks.slice(start, end).filter((block) => isAdvisoryMarker(block) || isBatchFailureMarker(block) || isRuntimeGuidanceMarker(block) || (compact && (block.kind === "tool" || block.kind === "thinking" || (block.kind === "marker" && !block.auth && (block.level === "info" || block.level === "note") && (BATCH.test(block.text) || RUN_META.test(block.text))))));
    if (work.length) {
      groups.set(work[0]!.id, { blocks: work, current: end === blocks.length });
      for (const block of work.slice(1)) skip.add(block.id);
    }
    start = end;
  }
  return blocks.flatMap((block): PhoneItem[] => {
    const group = groups.get(block.id);
    if (group) return [{ kind: "work", id: block.id, ...group }];
    return skip.has(block.id) ? [] : [{ kind: "block", id: block.id, block }];
  });
}
