// Presentation policy only. No network probes or remote browser control.
export function webAddress(value: string): string {
  const text = value.trim();
  if (!text || text.length > 2048 || /[\s\\\x00-\x1f]/.test(text)) throw new Error("Enter a website address.");
  const hostPort = /^(?:localhost|[\w.-]+|\[[\da-f:]+\]):\d+(?:[/?#]|$)/i.test(text);
  const scheme = !hostPort && /^[a-z][a-z0-9+.-]*:/i.test(text);
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text);
  const url = new URL(scheme ? text : `${local ? "http" : "https"}://${text}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS address without embedded credentials.");
  return url.href;
}
export function loopbackAddress(value: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname); } catch { return false; }
}
export function previewCandidate(value: string, appURL: string): boolean {
  try {
    const site = new URL(value), app = new URL(appURL);
    return loopbackAddress(app.href) && loopbackAddress(site.href) && site.protocol === "http:" && site.port !== app.port;
  } catch { return false; }
}
/** Inspect only recent displayed prose, bounded independently of transcript size. */
export function recentWebLinks(blocks: readonly { kind: string; text?: string }[]): string[] {
  const urls = new Set<string>();
  for (let i = blocks.length - 1, seen = 0; i >= 0 && seen < 16 && urls.size < 6; i--) {
    const b = blocks[i]!;
    if (!["text", "user"].includes(b.kind) || !b.text) continue;
    seen++;
    for (const match of b.text.slice(-8192).matchAll(/https?:\/\/[^\s<>"`]+/g)) {
      const raw = match[0].replace(/[),.;!?\]}]+$/, "");
      try { urls.add(webAddress(raw)); } catch { /* Not a navigable address. */ }
      if (urls.size >= 6) break;
    }
  }
  return [...urls];
}
