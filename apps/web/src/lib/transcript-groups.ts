// Presentation-only transcript grouping. The canonical SessionStore remains a
// flat, lossless journal projection; this module decides only how much of that
// machinery is mounted and shown in scrollback.
import type { ViewBlock } from "@dextui/client";
import { humanizeLabel, humanizeTool, parseRunMeta } from "./display";

export type ActivityKind = "read" | "edit" | "mixed";
export type TranscriptItem =
  | { kind: "block"; id: number; block: ViewBlock }
  | { kind: "activity"; id: number; tools: Extract<ViewBlock, { kind: "tool" }>[]; activity: ActivityKind; caption: string; progress?: Extract<ViewBlock, { kind: "text" }>; labels: string[] }
  | { kind: "meta"; id: number; blocks: Extract<ViewBlock, { kind: "marker" }>[] };

const READ_TOOLS = new Set(["read_file", "read_symbol", "rg", "fd", "git_diff", "git_status", "todo_read"]);
const EDIT_TOOLS = new Set(["edit_file", "multi_edit", "write_file", "todo_write"]);

export function activityKind(name: string): "read" | "edit" | null {
  const n = name.toLowerCase();
  if (READ_TOOLS.has(n)) return "read";
  if (EDIT_TOOLS.has(n)) return "edit";
  return null;
}

function foldableLabel(label: string): boolean {
  const i = label.indexOf(": ");
  return i > 0 && activityKind(label.slice(0, i)) !== null;
}

function batchLabels(block: ViewBlock | undefined): string[] | null {
  if (block?.kind !== "marker" || !block.text.startsWith("Batch: ")) return null;
  const rest = block.text.slice(7);
  if (!/^[a-z_][\w-]*: /i.test(rest)) return null; // not the failure marker
  return rest.split(" · ").filter(Boolean);
}

function metaBlock(block: ViewBlock): block is Extract<ViewBlock, { kind: "marker" }> {
  return block.kind === "marker" && !!parseRunMeta(block.text);
}

function shortCaption(text: string): string {
  const line = text
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:—-]\s*$/, "");
  if (line.length <= 100) return line;
  const cut = line.slice(0, 100);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 70 ? space : 100)}…`;
}

function fallbackCaption(tools: Extract<ViewBlock, { kind: "tool" }>[], kind: ActivityKind, labels: string[]): string {
  if (labels.length) {
    const first = humanizeLabel(labels[0] ?? "");
    return labels.length > 1 ? `${first} +${labels.length - 1} more` : first;
  }
  const first = tools[0];
  const detail = first ? humanizeTool(first.name, first.summary) : "";
  if (tools.length === 1 && detail) return detail;
  if (kind === "edit") return "Changed files";
  if (kind === "mixed") return "Reviewed and changed code";
  return "Inspected files and code";
}

/** Build bounded presentation groups from the already-windowed block slice.
 *
 * Conservative boundaries:
 * - bash, images, HTTP, commits, approvals/artifacts and unknown tools remain
 *   ordinary rich blocks;
 * - only complete assistant text immediately followed by foldable activity is
 *   consumed as a caption (a final answer has no following tools, so cannot be
 *   swallowed);
 * - objective/phase markers are coalesced per user turn, but every transition
 *   remains reachable in the meta disclosure.
 */
export function transcriptItems(blocks: ViewBlock[]): TranscriptItem[] {
  const metaAt = new Map<number, Extract<ViewBlock, { kind: "marker" }>[]>();
  const metaSkip = new Set<number>();
  let turnStart = 0;
  for (let end = 0; end <= blocks.length; end++) {
    if (end < blocks.length && blocks[end]?.kind !== "user") continue;
    const metas = blocks.slice(turnStart, end).filter(metaBlock);
    if (metas.length) {
      metaAt.set(metas[0]!.id, metas);
      for (const m of metas.slice(1)) metaSkip.add(m.id);
    }
    turnStart = end;
  }

  const out: TranscriptItem[] = [];
  for (let i = 0; i < blocks.length;) {
    const first = blocks[i]!;
    const metas = metaAt.get(first.id);
    if (metas) {
      out.push({ kind: "meta", id: first.id, blocks: metas });
      i++;
      continue;
    }
    if (metaSkip.has(first.id)) {
      i++;
      continue;
    }

    let caption = "";
    let progress: Extract<ViewBlock, { kind: "text" }> | undefined;
    let j = i;
    // Progress prose is folded only when structural activity follows directly
    // (optionally through its explicit batch marker).
    if (first.kind === "text" && first.complete) {
      let probe = i + 1;
      if (batchLabels(blocks[probe])) probe++;
      const next = blocks[probe];
      if (next?.kind === "tool" && activityKind(next.name)) {
        caption = shortCaption(first.text);
        progress = first;
        j = i + 1;
      }
    }

    const labels: string[] = [];
    const tools: Extract<ViewBlock, { kind: "tool" }>[] = [];
    let sawRead = false;
    let sawEdit = false;
    while (j < blocks.length) {
      const labelsHere = batchLabels(blocks[j]);
      if (labelsHere) {
        // Explicit parallel batches are semantic boundaries. Do not merge the
        // next emitted batch merely because no prose separates the markers.
        if (tools.length) break;
        // Consume a batch marker only if it actually introduces foldable work.
        let probe = j + 1;
        while (batchLabels(blocks[probe])) probe++;
        const next = blocks[probe];
        if (next?.kind !== "tool" || !activityKind(next.name)) break;
        labels.push(...labelsHere.filter(foldableLabel));
        j++;
        continue;
      }
      const block = blocks[j];
      if (block?.kind !== "tool") break;
      const k = activityKind(block.name);
      if (!k) break;
      tools.push(block);
      sawRead ||= k === "read";
      sawEdit ||= k === "edit";
      j++;
    }

    if (tools.length) {
      const activity: ActivityKind = sawRead && sawEdit ? "mixed" : sawEdit ? "edit" : "read";
      // A rich boundary (notably Bash) may split an explicit mixed batch. Keep
      // only as many structural labels as this actual fold contains, so its
      // summary never counts a later call that stayed outside.
      const groupLabels = labels.slice(0, tools.length);
      out.push({
        kind: "activity",
        id: first.id,
        tools,
        activity,
        caption: caption || fallbackCaption(tools, activity, groupLabels),
        progress,
        labels: groupLabels,
      });
      i = j;
      continue;
    }

    out.push({ kind: "block", id: first.id, block: first });
    i++;
  }
  return out;
}
