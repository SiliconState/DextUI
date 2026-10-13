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
  | { kind: "work"; id: number; blocks: ViewBlock[]; current: boolean; currentTurn: boolean };

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

/** Work cards describe their own tool outcomes, not the whole task. A response
 *  can arrive before a parallel tool finishes; keep that card active until its
 *  tool finishes (or the session stops). Notes alone cannot inherit turn failure. */
export function phoneWorkState(item: Extract<PhoneItem, { kind: "work" }>, session: Pick<SessionState, "working" | "failed">): "working" | "failed" | "complete" {
  const counts = phoneWorkCounts(item.blocks);
  const liveThinking = item.blocks.some((block) => block.kind === "thinking" && !block.complete);
  const unfinished = counts.running > 0 || counts.pending > 0 || liveThinking;
  if (session.working && item.currentTurn && (item.current || unfinished)) return "working";
  const batchFailed = item.blocks.some((block) => block.kind === "marker" && isBatchFailureMarker(block) && Number(BATCH_FAILURE.exec(block.text.trim())?.[1]) > 0);
  const execution = item.blocks.some((block) => block.kind === "tool" || block.kind === "thinking" || (block.kind === "marker" && !block.auth && (block.level === "info" || block.level === "note") && BATCH.test(block.text)));
  if (counts.failed > 0 || batchFailed || (item.currentTurn && session.failed && execution && (item.current || unfinished))) return "failed";
  return "complete";
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
  // only labels followed by tool rows before the next batch boundary (start
  // or failure). A recovery tool after a failed batch belongs to later work.
  const redundantBatches = new Set<number>();
  let followingTool = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool") followingTool = true;
    else if (isBatchFailureMarker(block)) followingTool = false;
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

function isPhoneWorkBlock(block: ViewBlock, compact: boolean): boolean {
  if (isAdvisoryMarker(block) || isBatchFailureMarker(block) || isRuntimeGuidanceMarker(block)) return true;
  if (!compact) return false;
  if (block.kind === "tool" || block.kind === "thinking") return true;
  return block.kind === "marker" && !block.auth && (block.level === "info" || block.level === "note") && (BATCH.test(block.text) || RUN_META.test(block.text));
}

/** Fold only consecutive work blocks, never across Dext responses or visible
 *  notices. The original order stays lossless: work, response, work, response.
 *  In Show all, tools remain rich; recognized runtime guidance stays contained. */
export function phoneTranscriptItems(blocks: ViewBlock[], compact = true): PhoneItem[] {
  const items: PhoneItem[] = [];
  let work: Extract<PhoneItem, { kind: "work" }> | undefined;
  let current: typeof work;
  const turnWork: NonNullable<typeof work>[] = [];
  for (const block of blocks) {
    if (block.kind === "user") turnWork.length = 0;
    if (isPhoneWorkBlock(block, compact)) {
      if (!work) {
        work = { kind: "work", id: block.id, blocks: [], current: false, currentTurn: false };
        items.push(work);
        turnWork.push(work);
      }
      work.blocks.push(block);
      // SessionStore inserts new annotations before an open thinking block.
      // Keep the oldest identity, not the new first row, so it stays mounted.
      work.id = Math.min(work.id, block.id);
      current = work;
    } else {
      items.push({ kind: "block", id: block.id, block });
      work = undefined;
      // A response closes the preceding work phase as soon as it streams.
      // Trailing warnings/errors still let the latest work show turn failure.
      if (block.kind !== "marker") current = undefined;
    }
  }
  for (const item of turnWork) item.currentTurn = true;
  if (current) current.current = true;
  return items;
}
