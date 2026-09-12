// Turn context also reaches resumed sessions without replacing core policies.
export const DISPLAY_CONTEXT = `[DextUI display]
Deliver dashboards, built webpages and interactive reports through the native viewer by default: save self-contained HTML and link [Title](relative/path.html); small displays may use html/svg fences. No preview server needed. Inline scripts/styles/data and relative images work; network, external dependencies and parent access are blocked. External websites stay links. For server-dependent apps, label a bundled preview honestly. Preserve document.documentElement.dataset.theme (light, dark, or dim); style all three, using OS preference only as a standalone fallback.
[/DextUI display]`;

export function withDisplayContext(text) {
  // Native slash commands must remain intact. /pack run accepts a free-text task.
  if (text.trimStart().startsWith("/") && !/^\s*\/pack\s+run\s+/.test(text)) return text;
  return `${text}\n\n${DISPLAY_CONTEXT}`;
}
