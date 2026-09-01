// Minimal escaped-by-construction markdown shaping: code fences, paragraphs,
// inline code, bold. No HTML strings, no injection surface.

export type Seg = { type: "code" | "text"; text: string; lang: string };
export type Inline = { t: "text" | "code" | "bold"; s: string };

export function splitFences(src: string): Seg[] {
  const out: Seg[] = [];
  let cur: string[] = [];
  let inCode = false;
  let lang = "";
  let codeBuf: string[] = [];
  const flushText = () => {
    if (cur.length > 0) {
      out.push({ type: "text", text: cur.join("\n"), lang: "" });
      cur = [];
    }
  };
  for (const line of src.split("\n")) {
    const fence = /^```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      if (!inCode) {
        flushText();
        inCode = true;
        lang = fence[1] ?? "";
        codeBuf = [];
      } else {
        out.push({ type: "code", text: codeBuf.join("\n"), lang });
        inCode = false;
      }
      continue;
    }
    if (inCode) codeBuf.push(line);
    else cur.push(line);
  }
  if (inCode) out.push({ type: "code", text: codeBuf.join("\n"), lang });
  flushText();
  return out;
}

export function inlineTokens(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ t: "text", s: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", s: m[1] });
    else out.push({ t: "bold", s: m[2] ?? "" });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", s: s.slice(last) });
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
