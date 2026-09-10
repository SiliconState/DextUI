// Presentation-only transcript grouping. The canonical SessionStore remains a
// flat, lossless journal projection; this module decides only how much of that
// machinery is mounted and shown in scrollback.
import type { ViewBlock } from "@dextui/client";
import { humanizeLabel, humanizeTool, parseRunMeta } from "./display";

export type ActivityKind = "read" | "web" | "image" | "edit" | "mixed";
export type TranscriptItem =
  | { kind: "block"; id: number; block: ViewBlock }
  | { kind: "activity"; id: number; tools: Extract<ViewBlock, { kind: "tool" }>[]; activity: ActivityKind; caption: string; labels: string[] }
  | { kind: "meta"; id: number; blocks: Extract<ViewBlock, { kind: "marker" }>[] };

const READ_TOOLS = new Set(["read_file", "read_symbol", "rg", "fd", "git_diff", "git_status", "todo_read"]);
const EDIT_TOOLS = new Set(["edit_file", "multi_edit", "write_file", "todo_write", "git_commit"]);

export function activityKind(name: string): Exclude<ActivityKind, "mixed"> | null {
  const n = name.toLowerCase();
  if (n === "http") return "web";
  if (n === "read_image") return "image";
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

function fallbackCaption(tools: Extract<ViewBlock, { kind: "tool" }>[], kind: ActivityKind, labels: string[]): string {
  if (labels.length) {
    const first = humanizeLabel(labels[0] ?? "");
    return labels.length > 1 ? `${first} +${labels.length - 1} more` : first;
  }
  const first = tools[0];
  const firstName = first?.name.toLowerCase() ?? "";
  const detail = first ? humanizeTool(first.name, first.summary) : "";
  if (tools.length === 1 && firstName === "read_image") return detail.replace(/^Inspect image\s*/i, "") || "image";
  if (tools.length === 1 && firstName === "http") return detail.replace(/^(?:HTTP|Request)\s*/i, "") || "request";
  if (tools.length === 1 && firstName === "git_commit") return detail.replace(/^Commit\s*/i, "") || "changes";
  if (tools.length === 1 && firstName === "write_file") return detail.replace(/^Write\s*/i, "") || "file";
  if (tools.length === 1 && detail) return detail;
  if (kind === "web") return "Web activity";
  if (kind === "image") return "Images";
  if (kind === "edit") return "Changed files";
  if (kind === "mixed") return "Reviewed and changed code";
  return "Inspected files and code";
}

/** Build bounded presentation groups from the already-windowed block slice.
 *
 * Conservative boundaries:
 * - bash remains an ordinary rich block; image, HTTP, and commit calls may
 *   fold but preserve meaningful outcomes in their summary and full drill-down;
 * - approvals/artifacts and unknown tools remain ordinary rich blocks;
 * - Dext text is always ordinary, prominent transcript prose; only tool cards
 *   and their technical batch markers fold;
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

    let j = i;

    const labels: string[] = [];
    const tools: Extract<ViewBlock, { kind: "tool" }>[] = [];
    let sawRead = false;
    let sawEdit = false;
    let specialKind: "web" | "image" | null = null;
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
      // Web and image work get their own visible category rather than being
      // absorbed into a neighboring generic file/code inspection group.
      if (tools.length && (specialKind !== null || k === "web" || k === "image") && k !== specialKind) break;
      tools.push(block);
      if (k === "web" || k === "image") specialKind = k;
      sawRead ||= k === "read";
      sawEdit ||= k === "edit";
      j++;
    }

    if (tools.length) {
      const activity: ActivityKind = specialKind ?? (sawRead && sawEdit ? "mixed" : sawEdit ? "edit" : "read");
      // A rich boundary (notably Bash) may split an explicit mixed batch. Keep
      // only as many structural labels as this actual fold contains, so its
      // summary never counts a later call that stayed outside.
      const groupLabels = labels.slice(0, tools.length);
      out.push({
        kind: "activity",
        id: first.id,
        tools,
        activity,
        caption: fallbackCaption(tools, activity, groupLabels),
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
