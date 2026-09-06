// Pure display helpers shared by components and state (no store imports, so
// lower layers like state.svelte can use them without a cycle).
import type { PackInfo } from "@dextui/protocol";

/** Capitalize the first letter of every word, leaving the rest untouched
 * ("Bank reconciliation" → "Bank Reconciliation", "TradingView" stays). Words
 * starting with a non-letter ("(Edge)", "&") keep their first real letter. */
export function titleCase(s: string): string {
  return s
    .split(/(\s+)/)
    .map((w) => {
      const i = w.search(/\p{L}/u);
      return i < 0 ? w : w.slice(0, i) + w.charAt(i).toUpperCase() + w.slice(i + 1);
    })
    .join("");
}

/** Pack display name: curated title when there is one, else the id with
 * `-`/`_` as spaces ("edge_browser" → "Edge Browser"). Always title-cased, so
 * no pack ever renders in small letters. */
export function packTitle(p: Pick<PackInfo, "name" | "ui">): string {
  return titleCase(p.ui.title ?? p.name.replace(/[-_]+/g, " "));
}

/** Natural-language tool summaries. Dext's technical forms — "rg: /re/ in
 * /abs/path (+3 args)", "read_file: /abs/path (offset=1)" — become "Search
 * for re in ~/…/src"; shell commands stay verbatim. Raw always keeps the
 * original, so this only buys readability. */
const VERBS: Record<string, string> = {
  rg: "Search",
  grep: "Search",
  glob: "Find",
  find: "Find",
  read: "Read",
  read_file: "Read",
  cat: "Read",
  ls: "List",
  list_dir: "List",
  write: "Write",
  write_file: "Write",
  edit: "Edit",
};
/** Tools whose summary is a state blob (todo_write's JSON) — the summary is
 * noise, so these render as a plain phrase and nothing else. */
const ALONE: Record<string, string> = {
  todo_write: "Update the todo list",
  todo_read: "Check the todo list",
};

function shortToken(s: string, n = 24): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** "~" for home, and past three segments keep only the last two. */
export function shortPath(p: string): string {
  const t = p.trim().replace(/^\/home\/[^/]+/, "~");
  const segs = t.split("/").filter(Boolean);
  return segs.length > 3 ? `${segs[0]}/…/${segs.slice(-2).join("/")}` : t;
}

export function humanizeTool(name: string, summary: string): string {
  const raw = (summary ?? "").trim();
  if (!raw) return raw;
  if (/^(bash|sh|shell)$/i.test(name)) return raw; // the command is the summary
  const alone = ALONE[name.toLowerCase()];
  if (alone) return alone;
  // Drop the trailing args hint ("(+3 args)", "(offset=1, limit=30)") and
  // any mid-truncation ellipsis the host already applied.
  const body = raw.replace(/\s*\([^()]{0,60}\)\s*$/, "").replace(/…$/, "").trim();
  const verb = VERBS[name.toLowerCase()];
  const m = body.match(/^\/(.+)\/\s+in\s+(\S.*)$/);
  if (m?.[1] !== undefined && m[2] !== undefined) return `${verb ?? "Search"} for ${shortToken(m[1])} in ${shortPath(m[2])}`;
  if (body.startsWith("/") && !body.includes(" ")) return `${verb ?? "Read"} ${shortPath(body)}`;
  return shortToken(raw, 72);
}

/** Batch labels carry their tool name ("rg: /re/ in /p"); split it off. */
export function humanizeLabel(l: string): string {
  const i = l.indexOf(": ");
  return i > 0 ? humanizeTool(l.slice(0, i), l.slice(i + 2)) : humanizeTool("", l);
}

/** Core's run-status annotations, emitted as info events: "[objective: … |
 * checkpoints: a; b]" opens a turn, "[phase:probe] note" marks transitions.
 * They are steering state, not conversation — the UI renders them as quiet
 * meta rows. Anything else (runtime control, host notices) returns null and
 * keeps the plain marker treatment. */
export interface RunMeta {
  objective?: string;
  checkpoints: string[];
  phase?: string;
  note?: string;
}
export function parseRunMeta(text: string): RunMeta | null {
  const t = (text ?? "").trim();
  const obj = t.match(/^\[objective:\s*([\s\S]+?)\s*(?:\|\s*checkpoints:\s*([\s\S]+?))?\]$/);
  if (obj?.[1] !== undefined) {
    return {
      objective: obj[1].trim(),
      checkpoints: (obj[2] ?? "").split(";").map((c) => c.trim()).filter(Boolean),
    };
  }
  const ph = t.match(/^\[phase:([a-z][a-z0-9-]*)\]\s*([\s\S]*)$/);
  if (ph?.[1] !== undefined) return { phase: ph[1], note: (ph[2] ?? "").trim(), checkpoints: [] };
  return null;
}
