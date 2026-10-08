// The only import of the diagram engine is inside this deferred module.
// Mermaid itself loads each diagram family on demand. Nothing calls `run`,
// binds callbacks, or scans model-authored HTML in the transcript.
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { unsafeDiagramCss, svgDimensions } from "./mermaid-svg";
import { diagramIssue, MERMAID_EDGE_LIMIT, MERMAID_SOURCE_LIMIT, MERMAID_SVG_LIMIT, type DiagramPalette, type DiagramResult } from "./mermaid-policy";

let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
const cache = new Map<string, DiagramResult>();
let cacheBytes = 0;
let cacheScope = 0;
let cacheRevision = 0;
export function clearDiagramCache(scope: number) { cacheScope = scope; cacheRevision++; cache.clear(); cacheBytes = 0; }
const CACHE_LIMIT = 2 * 1024 * 1024;

function remember(key: string, result: DiagramResult) {
  const bytes = 2 * (key.length + result.svg.length);
  if (bytes > CACHE_LIMIT) return;
  while (cache.size >= 12 || cacheBytes + bytes > CACHE_LIMIT) {
    const first = cache.entries().next().value;
    if (!first) break;
    cacheBytes -= 2 * (first[0].length + first[1].svg.length);
    cache.delete(first[0]);
  }
  cache.set(key, result);
  cacheBytes += bytes;
}

function sanitize(svg: string): DiagramResult {
  if (svg.length > MERMAID_SVG_LIMIT || new TextEncoder().encode(svg).length > MERMAID_SVG_LIMIT) throw new Error("Diagram output exceeds the display limit.");
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script", "image", "feImage", "a", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["href", "xlink:href", "src", "tabindex"],
  });
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg" || doc.querySelector("parsererror")) throw new Error("Diagram output is not a valid SVG.");
  // Only local marker/paint references are needed. Reject remote CSS before
  // the SVG is used as an inert image (never inserted into the chat DOM).
  for (const node of [root, ...root.querySelectorAll("style, [style]")]) {
    const css = node.localName === "style" ? node.textContent ?? "" : node.getAttribute("style") ?? "";
    if (unsafeDiagramCss(css)) throw new Error("Diagram output contains external styling.");
  }
  for (const node of [root, ...root.querySelectorAll("*")]) for (const attr of [...node.attributes]) {
    if (/^on/i.test(attr.name) || /url\s*\(/i.test(attr.value) && unsafeDiagramCss(attr.value)) throw new Error("Diagram output contains an unsafe reference.");
  }
  const { width, height } = svgDimensions(root.getAttribute("viewBox"), root.getAttribute("width"), root.getAttribute("height"));
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  const serialized = new XMLSerializer().serializeToString(root);
  if (serialized.length > MERMAID_SVG_LIMIT || new TextEncoder().encode(serialized).length > MERMAID_SVG_LIMIT) throw new Error("Diagram output exceeds the display limit.");
  return { svg: serialized, width, height };
}

export function renderDiagram(source: string, palette: DiagramPalette, wanted: () => boolean, scope: number): Promise<DiagramResult | null> {
  // Scope is owned by App/loader, never by a late queued render call.
  if (scope !== cacheScope || !wanted()) return Promise.resolve(null);
  const revision = cacheRevision;
  const issue = diagramIssue(source);
  if (issue) return Promise.reject(new Error(issue));
  const key = JSON.stringify(palette) + "\n" + source;
  const job = queue.then(async () => {
    if (!wanted() || scope !== cacheScope || revision !== cacheRevision) return null;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    const id = `dextdiagram${++nextId}`;
    const scratch = document.createElement("div");
    scratch.setAttribute("aria-hidden", "true");
    scratch.inert = true;
    scratch.style.cssText = "position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none;";
    document.body.appendChild(scratch);
    try {
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", htmlLabels: false,
        suppressErrorRendering: true, maxTextSize: MERMAID_SOURCE_LIMIT, maxEdges: MERMAID_EDGE_LIMIT,
        secure: ["securityLevel", "htmlLabels", "startOnLoad", "maxTextSize", "maxEdges", "theme", "themeVariables", "layout"],
        theme: "base", layout: "dagre", fontFamily: "system-ui, sans-serif", fontSize: 14,
        themeVariables: {
          darkMode: palette.dark, background: palette.background,
          primaryColor: palette.surface, primaryTextColor: palette.text,
          primaryBorderColor: palette.border, secondaryColor: palette.background,
          tertiaryColor: palette.surface, lineColor: palette.line, textColor: palette.text,
          mainBkg: palette.surface, nodeBorder: palette.border, clusterBkg: palette.background,
          clusterBorder: palette.border, titleColor: palette.text, edgeLabelBackground: palette.background,
          actorBkg: palette.surface, actorBorder: palette.border, actorTextColor: palette.text,
          actorLineColor: palette.line, signalColor: palette.text, signalTextColor: palette.text,
          labelBoxBkgColor: palette.surface, labelBoxBorderColor: palette.border,
          labelTextColor: palette.text, noteBkgColor: palette.surface, noteTextColor: palette.text,
          noteBorderColor: palette.border, activationBkgColor: palette.surface,
          activationBorderColor: palette.accent, fontFamily: "system-ui, sans-serif", fontSize: "14px",
        },
        flowchart: { useMaxWidth: false, htmlLabels: false, wrappingWidth: 160, nodeSpacing: 24, rankSpacing: 32 },
        sequence: { useMaxWidth: false },
      });
      const { svg } = await mermaid.render(id, source, scratch);
      if (!wanted() || scope !== cacheScope || revision !== cacheRevision) return null;
      const result = sanitize(svg);
      remember(key, result);
      return result;
    } finally {
      scratch.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  // A failed diagram must never poison rendering of subsequent diagrams.
  queue = job.then(() => {}, () => {});
  return job;
}
