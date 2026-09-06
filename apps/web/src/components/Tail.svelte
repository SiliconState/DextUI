<script lang="ts">
  // Crew tail/file/escalation panes. Worker output is usually markdown the
  // agents wrote — render it (headings, lists, tables, code) instead of a raw
  // <pre>; plain shell logs stay line-oriented with level coloring. The chip
  // in the corner flips any pane back to its raw original text.
  import Markdown from "./Markdown.svelte";

  let {
    text,
    mode = "auto",
    file = false,
    sessionId = "",
    raw = $bindable(false),
  }: { text: string; mode?: "auto" | "md" | "log"; file?: boolean; sessionId?: string; raw?: boolean } = $props();

  // Markdown sniffing: a strong signal alone decides, weak ones need two,
  // and timestamped log output never counts — whatever tokens it carries.
  const STRONG: RegExp[] = [/^\s{0,3}#{1,6}\s+\S/m, /```/, /^\|.+\|$/m];
  const WEAK: RegExp[] = [/^\s{0,3}([-*+]|\d+\.)\s+\S/m, /\*\*[^*\n]+\*\*/];
  const STAMPED = /^(\[\d{4}-|\d{4}-\d{2}-\d{2}[T ]|\d{2}:\d{2}:\d{2})/;
  function isMarkdown(t: string): boolean {
    const s = t ?? "";
    const lines = s.split("\n").filter((l) => l.trim());
    if (!lines.length) return false;
    if (lines.filter((l) => STAMPED.test(l.trim())).length / lines.length >= 0.4) return false;
    if (STRONG.some((re) => re.test(s))) return true;
    return WEAK.filter((re) => re.test(s)).length >= 2;
  }
  const isMd = $derived(mode === "md" || (mode === "auto" && isMarkdown(text)));
  const lines = $derived((text ?? "").split("\n"));

  function level(l: string): string {
    if (/\b(error|failed|failure|fatal|panic|✗)\b/i.test(l)) return "err";
    if (/\b(warn|warning|⚠)\b/i.test(l)) return "warn";
    if (/\b(ok|done|success|✓|✔)\b/i.test(l)) return "ok";
    return "";
  }
  const isCmd = (l: string): boolean => /^\s*\$\s/.test(l);
</script>

<div class="pane" class:file data-agent-id="crew.tail" data-state={raw ? "raw" : isMd ? "rendered" : "log"}>
  <button
    class="chip"
    data-agent-id="crew.tail.raw"
    title={raw ? "Render as formatted output" : "Show the raw original"}
    onclick={() => (raw = !raw)}
  >{raw ? "rendered" : "raw"}</button>
  {#if isMd && !raw}
    <div class="sc mdc"><Markdown src={text} {sessionId} /></div>
  {:else}
    <div class="sc logc" role="log">
      {#each lines as l, i (i)}
        <div class="ln {level(l)}" class:cmd={isCmd(l)}>{l || " "}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Fully self-contained: parents style the pane header only. */
  .pane {
    position: relative;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
  }
  .sc {
    overflow: auto;
    max-height: 46dvh;
    padding: 10px 42px 12px 14px; /* right padding keeps text clear of the chip */
  }
  .chip {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 2;
    font-size: 10px;
    letter-spacing: 0.05em;
    padding: 1px 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg1);
    color: var(--faint);
  }
  .chip:hover {
    color: var(--fg);
    border-color: var(--dim);
  }
  /* Rendered markdown, compacted for a pane rather than the transcript. */
  .mdc {
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--dim);
  }
  .pane.file .mdc,
  .pane.file .logc {
    color: var(--fg);
  }
  .mdc :global(h1),
  .mdc :global(h2) {
    font-size: 13px;
    margin: 0.6em 0 0.2em;
    color: var(--fg);
  }
  .mdc :global(h3),
  .mdc :global(h4),
  .mdc :global(h5),
  .mdc :global(h6) {
    font-size: 12.5px;
    margin: 0.5em 0 0.15em;
    color: var(--fg);
  }
  .mdc :global(:first-child) {
    margin-top: 0;
  }
  .mdc :global(p) {
    margin: 0.3em 0;
  }
  .mdc :global(ul),
  .mdc :global(ol) {
    margin: 0.3em 0;
    padding-left: 1.5em;
  }
  .mdc :global(li) {
    margin: 0.1em 0;
  }
  .mdc :global(pre) {
    margin: 0.35em 0;
    padding: 6px 8px;
    background: var(--bg1);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow-x: auto;
    white-space: pre;
    font-size: 12px;
  }
  .mdc :global(table) {
    font-size: 12px;
    margin: 0.35em 0;
  }
  .mdc :global(blockquote) {
    margin: 0.35em 0;
    padding: 0.1em 0 0.1em 10px;
    border-left: 2px solid var(--line);
    color: var(--faint);
  }
  .mdc :global(hr) {
    border: 0;
    border-top: 1px solid var(--line);
    margin: 0.6em 0;
  }
  /* Plain shell output: mono, breathable, level-colored. */
  .logc {
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    font-size: 12px;
    line-height: 1.55;
    color: var(--dim);
  }
  .ln {
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 1.3em;
  }
  .ln.cmd {
    color: var(--cyan);
  }
  .ln.err {
    color: var(--red);
  }
  .ln.warn {
    color: var(--yellow);
  }
  .ln.ok {
    color: var(--green);
  }
  .ln.err,
  .ln.warn,
  .ln.ok {
    font-weight: 500;
  }
</style>
