// This is presentation input, never executable HTML or a config extension.
export const MERMAID_SOURCE_LIMIT = 16 * 1024;
export const MERMAID_LINE_LIMIT = 256;
export const MERMAID_EDGE_LIMIT = 160;
export const MERMAID_SVG_LIMIT = 1024 * 1024;

export function diagramIssue(source: string): string | null {
  if (source.length > MERMAID_SOURCE_LIMIT || new TextEncoder().encode(source).length > MERMAID_SOURCE_LIMIT) return "Diagram exceeds the 16 KiB display limit.";
  if (!source.trim()) return "Diagram source is empty.";
  const normalized = source.replace(/\r\n?/g, "\n");
  if (normalized.split("\n").length > MERMAID_LINE_LIMIT) return "Diagram exceeds the 256-line display limit.";
  if (normalized.split(/[;\n]/).filter(line => line.trim()).length > 256 || (source.match(/&|@\{|\[|\(|\{/g)?.length ?? 0) > 400) return "Diagram has too many elements.";
  if ((source.match(/(?:--+>|==+>|-\.->|<--+|--+|==+|~~~)/g)?.length ?? 0) > MERMAID_EDGE_LIMIT) return "Diagram has too many connections.";
  // Mermaid processes directives/frontmatter before security configuration.
  // Do not let model content change the site's settings, load resources, or
  // inject CSS/HTML while the library measures its temporary rendering DOM.
  if (/^\s*---\s*(?:\n|$)/.test(normalized) || /%%\s*\{/.test(normalized)) return "Diagram configuration directives are disabled.";
  if (/(?:^|[;\n])\s*(?:click|style|class|classDef|linkStyle|callback|links?|properties|details)\b/i.test(normalized) || /\b(?:UpdateElementStyle|UpdateRelStyle|UpdateLayoutConfig)\b/i.test(normalized) || /\$[^\n=]*=/.test(normalized)) return "Diagram actions and custom styles are disabled.";
  // Family-specific styling (not just flowchart classDef) reaches live scratch
  // DOM before sanitization. CSS escapes can disguise url() in C4 paint values.
  if (/\\/.test(source)) return "Escaped diagram syntax is not enabled in this view.";
  // Mermaid decodes YAML/JSON metadata before rendering. Quoted/escaped img
  // and icon keys can fetch relative URLs during measurement, before output
  // sanitization. Keep metadata/resource decoration as source, not a diagram.
  if (/@\s*\{|::\s*icon\s*\(/i.test(normalized)) return "Diagram metadata and resource decorations are disabled.";
  if (/<\s*[a-z!/]|(?:&(?:#\d+|#x[\da-f]+|[a-z][\w]+)|#(?:\d+|x[\da-f]+|[a-z]+));/i.test(source)) return "HTML and encoded markup are disabled in diagrams.";
  if (/\b(?:https?:|javascript:|data:|file:|blob:)|(?:url\s*\(|@import)|!\[[^\]]*\]\s*\(|\b(?:img|image|icon)\s*:/i.test(source)) return "External resources are disabled in diagrams.";
  if (/\$\$/.test(source)) return "Math labels are not enabled in this diagram view.";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return "Diagram contains control characters.";
  return null;
}

export type DiagramPalette = { background: string; surface: string; text: string; border: string; accent: string; line: string; dark: boolean };
export type DiagramResult = { svg: string; width: number; height: number };

export function diagramSourceForWidth(source: string, narrow: boolean): string {
  if (!narrow) return source;
  // Change only the top-level orientation, never labels, edges, subgraph
  // directions or copied source. Comments may precede the diagram header.
  return source.replace(/^((?:\s*%%[^\r\n]*(?:\r\n?|\n))*\s*(?:flowchart|graph)\s+)(LR|RL)(?=\s|;|$)/, (_, prefix: string, direction: string) => prefix + (direction === "LR" ? "TD" : "BT"));
}

export function diagramScale(width: number, height: number, available: number, maxHeight: number): number {
  return Math.min(1, Math.max(1, available - 24) / width, maxHeight / height);
}
