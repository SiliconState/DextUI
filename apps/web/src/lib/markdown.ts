// Markdown engine for agent output. Escaped-by-construction: the parser emits
// typed tokens, the renderer emits real DOM elements — no HTML strings, no
// injection surface. Web-native structure (true tables, lists, headings,
// links) instead of terminal box-drawing that shreds when lines wrap.

export type Inline =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "link"; s: string; href: string };

export interface ListItem {
  inline: Inline[];
  sub: { inline: Inline[] }[];
}

export type MdBlock =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "para"; inline: Inline[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "table"; align: ("l" | "c" | "r")[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "art"; text: string } // pre-drawn ASCII/box art: never re-wrap it
  | { kind: "hr" };

const TABLE_SEP = /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;
const BOX_ART = /^\s*[│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝▉▊█]/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ t: "text", s: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "bold", s: m[2] });
    else if (m[3] !== undefined && m[4] !== undefined) out.push({ t: "link", s: m[3], href: m[4] });
    else out.push({ t: "italic", s: m[5] ?? "" });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", s: s.slice(last) });
  return out;
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i] ?? "";
    if (ch === "`" && l[i - 1] !== "\\") inCode = !inCode;
    if (ch === "|" && !inCode && l[i - 1] !== "\\") {
      cells.push(cell.trim());
      cell = "";
    } else if (ch === "\\" && l[i + 1] === "|") {
      cell += "|";
      i++;
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  const next = lines[i + 1] ?? "";
  return line.includes("|") && next.includes("-") && TABLE_SEP.test(next);
}

export function parseMarkdown(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // fenced code
    const fence = /^```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or EOF)
      out.push({ kind: "code", text: buf.join("\n"), lang: fence[1] ?? "" });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // pre-drawn box/ASCII art: preserve verbatim, never wrap
    if (BOX_ART.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && BOX_ART.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      out.push({ kind: "art", text: buf.join("\n") });
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: (h[1] ?? "#").length, inline: parseInline(h[2] ?? "") });
      i++;
      continue;
    }

    // horizontal rule
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !isTableStart(lines, i)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    // GFM pipe table
    if (isTableStart(lines, i)) {
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1] ?? "").map((c): "l" | "c" | "r" => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "c" : r ? "r" : "l";
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitRow(lines[i] ?? "").map(parseInline));
        i++;
      }
      out.push({ kind: "table", align, head, rows });
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", inline: parseInline(buf.join(" ")) });
      continue;
    }

    // list (one nesting level; deeper indents merge into the sublist)
    if (LIST_ITEM.test(line)) {
      const first = LIST_ITEM.exec(line);
      const ordered = /\d/.test(first?.[2] ?? "");
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i] ?? "");
        if (!m) break;
        const indent = (m[1] ?? "").length;
        const inline = parseInline(m[3] ?? "");
        const parent = items[items.length - 1];
        if (indent >= 2 && parent) parent.sub.push({ inline });
        else items.push({ inline, sub: [] });
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }

    // paragraph: accumulate until blank or a structural line
    const buf = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        !l.trim() ||
        /^(#{1,6})\s/.test(l) ||
        /^```/.test(l) ||
        /^\s*>\s?/.test(l) ||
        /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        LIST_ITEM.test(l) ||
        BOX_ART.test(l) ||
        isTableStart(lines, i)
      )
        break;
      buf.push(l);
      i++;
    }
    out.push({ kind: "para", inline: parseInline(buf.join("\n")) });
  }
  return out;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
